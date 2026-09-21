require("dotenv/config");
const express = require("express");
const cors = require("cors");
const mongoose = require("mongoose");
const fileUpload = require("express-fileupload");
const http = require("http");
const { Server } = require("socket.io");
const Notification = require("./models/notifications.js");

const { upload } = require("./config/cloudinary.js");
const { cloudinaryVidUpload } = require("./config/cloudinary.js");

const authRoute = require("./routes/authRoute");
const userRouter = require("./routes/userRoute");
const courseRouter = require("./routes/courseRoute");
const accessmentRouter = require("./routes/assessments");
const notificationRouter = require("./routes/notification");
const resourceRoute = require("./routes/resourceRouter");
const eventRouter = require("./routes/eventRoute");
const categoryRoute = require("./routes/categoryRoute");
const noticeRouter = require("./routes/noticeRouter");
const transactionRouter = require("./routes/transactionRoute");
const appointmentRouter = require("./routes/appointmentRouter.js");
const certificateRouter = require("./routes/certificateRouter.js");
const startUpKitRouter = require("./routes/startupkit.js");
const workspaceRouter = require("./routes/workspaceRoute.js");
const partnerRouter = require("./routes/partnerRoute.js");

const Chat = require("./models/chat");
const User = require("./models/user");

const { sendEmail } = require("./utils/sendEmail");
const { startCronJobs } = require("./utils/ReminderSetupEmail");
const { startWithdrawalReconciliation } = require("./utils/withdrawalReconciler");
const { startPaymentReconciliation } = require("./utils/paymentReconciler");
const { startAutoPayouts } = require("./services/autoPayoutService");

const bodyParser = require("body-parser");
const { connect } = require("./config/connectionState");
const { default: axios } = require("axios");

const app = express();
const server = http.createServer(app);

// Origin allowlist. `origin: "*"` together with `credentials: true` is rejected by
// browsers, so the previous config silently broke any credentialed request. When no
// allowlist is configured we stay permissive but drop credentials, which is the only
// spec-valid form of a wildcard.
const allowedOrigins = [
  process.env.FRONTEND_URL,
  process.env.TRAINING_URL,
  ...(process.env.ALLOWED_ORIGINS || "").split(","),
]
  .map((value) => (value || "").trim().replace(/\/$/, ""))
  .filter(Boolean);

const corsOptions = allowedOrigins.length
  ? {
      origin: (origin, callback) => {
        // No Origin header: same-origin, curl, or server-to-server (e.g. the gateway webhook).
        if (!origin) return callback(null, true);
        const normalized = origin.replace(/\/$/, "");
        if (allowedOrigins.includes(normalized)) return callback(null, true);
        return callback(new Error("Not allowed by CORS"));
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "verif-hash"],
      maxAge: 86400,
    }
  : { origin: "*", credentials: false };

const io = new Server(server, {
  cors: {
    origin: allowedOrigins.length ? allowedOrigins : "*",
    methods: ["GET", "POST"],
  },
});

const PORT = process.env.PORT || 3002;
startCronJobs();
startWithdrawalReconciliation();
startPaymentReconciliation();
startAutoPayouts();
// Middleware
app.use(cors(corsOptions));

// Behind a load balancer / reverse proxy, req.ip must come from X-Forwarded-For or
// every request looks like it originates from the proxy and rate limiting keys collide.
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use(express.urlencoded({ extended: false }));
app.use(bodyParser.json({ limit: "35mb" }));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static("public"));
app.set("view engine", "ejs");
app.use(express.json());

// File upload middleware
app.use(
  fileUpload({
    useTempFiles: true,
  })
);

// Connect to database
connect();

app.get("/", (req, res) => {
  res.status(200).json({ message: "Experthub Trainings API is running" });
});
// Routes
app.use("/auth", authRoute);
app.use("/user", userRouter);
app.use("/courses", courseRouter);
app.use("/events", eventRouter);
app.use("/resources", resourceRoute);
app.use("/assessment", accessmentRouter);
app.use("/notifications", notificationRouter);
app.use("/category", categoryRoute);
app.use("/notice", noticeRouter);
app.use("/transactions", transactionRouter);
app.use("/appointment", appointmentRouter);
app.use("/certificate", certificateRouter);
app.use("/start-up-kit", startUpKitRouter);
app.use("/workspace", workspaceRouter);
app.use("/partner", partnerRouter);

app.get("/health", (req, res) => {
  const states = ["disconnected", "connected", "connecting", "disconnecting"];
  const state = states[mongoose.connection.readyState] || "unknown";
  const healthy = mongoose.connection.readyState === 1;
  res.status(healthy ? 200 : 503).json({ status: healthy ? "ok" : "degraded", database: state });
});

app.use((req, res) => {
  res.status(404).json({ message: `Route ${req.method} ${req.originalUrl} not found` });
});

// Global error handler. Without this, a throw inside a route left the request hanging
// until the client timed out, and stack traces could leak to the response body.
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);

  if (error?.message === "Not allowed by CORS") {
    return res.status(403).json({ message: "Origin not allowed" });
  }
  // Malformed ObjectId in a route param would otherwise surface as a 500.
  if (error?.name === "CastError") {
    return res.status(400).json({ message: `Invalid ${error.path}` });
  }
  if (error?.name === "ValidationError") {
    return res.status(400).json({ message: Object.values(error.errors || {}).map((e) => e.message).join(", ") || "Validation failed" });
  }
  if (error?.code === 11000) {
    return res.status(409).json({ message: "This record already exists" });
  }
  if (error?.type === "entity.too.large") {
    return res.status(413).json({ message: "Upload is too large" });
  }
  if (error instanceof SyntaxError && "body" in error) {
    return res.status(400).json({ message: "Malformed JSON body" });
  }

  console.error("Unhandled error:", req.method, req.originalUrl, error);
  return res.status(500).json({ message: "Something went wrong. Please try again." });
});

// A rejected promise or uncaught throw outside the request cycle would otherwise kill
// the process silently mid-payment. Log it and let the orchestrator restart us.
process.on("unhandledRejection", (reason) => {
  console.error("Unhandled promise rejection:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("Uncaught exception:", error);
});
process.on("SIGTERM", () => {
  console.log("SIGTERM received, closing server");
  server.close(() => process.exit(0));
});

// Socket.io logic
io.on("connection", async (socket) => {
  const user_id = socket.handshake.query["user_id"];

  console.log(`User connected ${socket.id}`);

  // Every socket joins a room named for its user, so a change that concerns one
  // person (a block, an unblock) can be delivered to their open tabs without
  // being broadcast to the whole platform. A blocking action used to go out as a
  // global broadcast, which leaked the event to every connected user.
  if (user_id) socket.join(`user:${user_id}`);

  // if (user_id) {
  //   try {
  //     await User.findByIdAndUpdate(user_id, {
  //       socket_id: socket.id,
  //       status: "Online",
  //     });
  //   } catch (e) {
  //     console.log(e);
  //   }
  // }

  socket.on("get_direct_conversations", async ({ user_id }, callback) => {
    const existing_conversations = await Chat.find({
      participants: { $all: [user_id] },
    }).populate("participants", "fullname _id email profilePicture");

    // console.log(existing_conversations);

    callback(existing_conversations);
  });

  socket.on("start_conversation", async (data, callback) => {
    const { to, from } = data;

    const existing_conversations = await Chat.find({
      participants: { $size: 2, $all: [to, from] },
    }).populate("participants", "fullname _id email profilePicture");

    console.log(existing_conversations[0], "Existing Conversation");

    if (existing_conversations.length === 0) {
      let new_chat = await Chat.create({
        participants: [to, from],
      });

      new_chat = await Chat.findById(new_chat._id).populate(
        "participants",
        "fullname _id email profilePicture"
      );

      // console.log(new_chat);

      socket.emit("start_chat", new_chat);
      if (callback) callback(new_chat);
    } else {
      socket.emit("start_chat", existing_conversations[0]);
      if (callback) callback(existing_conversations[0]);
    }
  });

  socket.on("get_messages", async (data, callback) => {
    try {
      const { messages } = await Chat.findById(data.conversation_id).select(
        "messages"
      );
      callback(messages);
    } catch (error) {
      console.log(error);
    }
  });

  socket.on("send_dm", async (data) => {
    console.log("Received message:", data);

    try {
      const { text, conversation_id, from, to, type, file } = data;

      // A block only means something if it stops delivery. Without this the
      // blocked party's messages were still written to the transcript and pushed
      // to the blocker, so the UI said "blocked" while the messages kept coming.
      const chat = await Chat.findById(conversation_id);
      if (!chat) {
        console.error("send_dm: conversation not found", conversation_id);
        return;
      }
      if (chat.blocked?.isBlocked) {
        const blockedBy = String(chat.blocked.by);
        // The blocker may still write into their own thread (nothing is delivered
        // to them), but the person they blocked may not.
        if (blockedBy !== String(from)) {
          socket.emit("message_rejected", {
            conversation_id,
            reason: "This conversation is blocked",
          });
          return;
        }
      }

      const from_user = await User.findById(from);
      let cloudFile;
      if (type === "Image" || type === "Document") {
        const image = await upload(file);
        cloudFile = image.url;
      } else if (type === "Video") {
        const video = await cloudinaryVidUpload(file);
        console.log("Uploaded video info:", video);
        cloudFile = video;
      }

      const new_message = {
        to: to,
        from: from,
        type: type,
        created_at: Date.now(),
        text: text || null,
        file: cloudFile,
      };

      chat.messages.push(new_message);
      await chat.save({ new: true, validateModifiedOnly: true });

      await Notification.create({
        title: "Message",
        content: `${from_user.fullname} Just sent you a message '${text}'`,
        contentId: conversation_id,
        userId: to,
      });

      // Delivered to the recipient's own room. `io.to(x).broadcast.emit(...)`
      // excludes room x, so the old form sent the message to every *other*
      // connected socket and never to the person it was addressed to.
      io.to(`user:${to}`).emit("new_message", {
        conversation_id,
        message: new_message,
      });
    } catch (e) {
      console.error("Error sending message:", e);
    }
  });

  socket.on("block_user", async (data, callback) => {
    const { by, conversation_id } = data || {};
    const reply = (payload) => { if (typeof callback === "function") callback(payload); };

    try {
      if (!conversation_id || !by) {
        reply({ error: "A conversation and a user are required" });
        return;
      }

      const chat = await Chat.findById(conversation_id);
      if (!chat) {
        reply({ error: "Conversation not found" });
        return;
      }
      // Only a participant can block the thread they are in.
      if (!chat.participants.some((id) => String(id) === String(by))) {
        reply({ error: "You are not part of this conversation" });
        return;
      }

      // Idempotent: blocking an already-blocked thread reports success rather
      // than erroring, so a retried click is not surfaced as a failure.
      chat.blocked = { isBlocked: true, by: by };
      await chat.save();

      // The ack is what the caller's UI waits on, and it carries the resulting
      // state so the client never has to guess.
      reply({ ok: true, conversation_id, isBlocked: true, by: String(by) });

      // The other participant's pane has to update live — that is the difference
      // between "blocked" meaning something and it only taking effect on reload.
      chat.participants
        .filter((id) => String(id) !== String(by))
        .forEach((id) => {
          io.to(`user:${id}`).emit("conversation_block_changed", {
            conversation_id,
            isBlocked: true,
            by: String(by),
          });
        });

      console.log(`User ${by} blocked conversation ${conversation_id}`);
    } catch (error) {
      console.error("Error blocking user:", error);
      reply({ error: "Error blocking user" });
    }
  });

  socket.on("unblock_user", async (data, callback) => {
    const { by, conversation_id } = data || {};
    const reply = (payload) => { if (typeof callback === "function") callback(payload); };

    try {
      if (!conversation_id || !by) {
        reply({ error: "A conversation and a user are required" });
        return;
      }

      const chat = await Chat.findById(conversation_id);
      if (!chat) {
        reply({ error: "Conversation not found" });
        return;
      }

      // Guarded with optional access: a thread that was never blocked has no
      // `blocked` subdocument, and reading `.isBlocked` off it used to throw
      // before the authorization check could even run.
      const blockedBy = chat.blocked?.by;
      if (!chat.blocked?.isBlocked) {
        reply({ ok: true, conversation_id, isBlocked: false, by: null });
        return;
      }
      if (String(blockedBy) !== String(by)) {
        reply({ error: "You are not authorized to unblock this conversation" });
        return;
      }

      chat.blocked = { isBlocked: false, by: null };
      await chat.save();

      reply({ ok: true, conversation_id, isBlocked: false, by: null });

      chat.participants
        .filter((id) => String(id) !== String(by))
        .forEach((id) => {
          io.to(`user:${id}`).emit("conversation_block_changed", {
            conversation_id,
            isBlocked: false,
            by: null,
          });
        });

      console.log(`Conversation ${conversation_id} unblocked by user ${by}`);
    } catch (error) {
      console.error("Error unblocking user:", error);
      reply({ error: "Error unblocking the conversation" });
    }
  });

  socket.on("delete_message", async (data) => {
    const { conversation_id, message_id, user_id } = data;

    try {
      const chat = await Chat.findById(conversation_id);

      if (!chat) {
        return socket.emit("error", { message: "Conversation not found" });
      }

      // Find the message by ID
      const message = chat.messages.id(message_id);

      if (!message) {
        return socket.emit("error", { message: "Message not found" });
      }

      // Check if the user requesting the delete is the author of the message
      if (String(message.from) !== String(user_id)) {
        return socket.emit("error", {
          message: "You are not authorized to delete this message",
        });
      }

      // Remove the message
      chat.messages = chat.messages.filter(
        (msg) => msg._id.toString() !== message_id
      );

      await chat.save();

      // Emit success message
      socket.emit("message_deleted", {
        conversation_id,
        message_id,
      });

      console.log(`Message ${message_id} deleted by user ${user_id}`);
    } catch (error) {
      console.error("Error deleting message:", error);
      socket.emit("error", { message: "Error deleting message" });
    }
  });

  socket.on("edit_message", async (data) => {
    const { conversation_id, message_id, newText, user_id } = data;

    try {
      const chat = await Chat.findById(conversation_id);

      if (!chat) {
        return socket.emit("error", { message: "Conversation not found" });
      }

      // Find the message by ID
      const message = chat.messages.find(
        (msg) => msg._id.toString() === message_id
      );

      if (!message) {
        return socket.emit("error", { message: "Message not found" });
      }

      // Check if the user requesting the edit is the author of the message
      if (String(message.from) !== String(user_id)) {
        return socket.emit("error", {
          message: "You are not authorized to edit this message",
        });
      }

      // Update the message text
      message.text = newText;

      await chat.save();

      // Emit success message
      socket.emit("message_edited", {
        conversation_id,
        message_id,
        newText,
      });

      console.log(`Message ${message_id} edited by user ${user_id}`);
    } catch (error) {
      console.error("Error editing message:", error);
      socket.emit("error", { message: "Error editing message" });
    }
  });

  // Handle when a user starts typing
  socket.on("typing", ({ conversation_id, user_fullname }) => {
    // Broadcast to other users in the conversation that this user is typing
    socket.broadcast.emit("user_typing", { conversation_id, user_fullname });
  });

  socket.on("stop_typing", ({ conversation_id }) => {
    socket.broadcast.emit("user_stopped_typing", { conversation_id });
  });

  socket.on("mark_all_as_read", async ({ chat_id, user_id }) => {
    try {
      // Update messages to mark them as read in the specific chat document
      const result = await Chat.updateMany(
        { _id: chat_id, "messages.to": user_id },
        { $set: { "messages.$[elem].read": true } },
        {
          arrayFilters: [{ "elem.to": user_id }],
        }
      );

      // Log the result to see if any documents were modified
      // console.log('Messages marked as read:', result);

      // Notify other participants in the chat
      socket.broadcast.emit("all_messages_read", { chat_id, user_id });
    } catch (error) {
      console.error("Error marking messages as read:", error);
    }
  });

  socket.on("end", async (data) => {
    if (data.user_id) {
      await User.findByIdAndUpdate(data.user_id, { status: "Offline" });
    }
    console.log("closing connection");
    socket.disconnect(0);
  });
});

server.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
