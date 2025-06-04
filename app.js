require('dotenv/config');
const express = require('express');
const cors = require('cors');
const fileUpload = require('express-fileupload');
const http = require('http');
const { Server } = require("socket.io");
const Notification = require("./models/notifications.js");

const { upload } = require("./config/cloudinary.js");
const { cloudinaryVidUpload } = require("./config/cloudinary.js");

const authRoute = require('./routes/authRoute');
const userRouter = require('./routes/userRoute');
const courseRouter = require('./routes/courseRoute');
const accessmentRouter = require('./routes/assessments');
const notificationRouter = require('./routes/notification');
const resourceRoute = require('./routes/resourceRouter');
const eventRouter = require('./routes/eventRoute');
const categoryRoute = require('./routes/categoryRoute');
const noticeRouter = require('./routes/noticeRouter');
const transactionRouter = require('./routes/transactionRoute');
const appointmentRouter = require('./routes/appointmentRouter.js');
const certificateRouter = require('./routes/certificateRouter.js');
const startUpKitRouter = require('./routes/startupkit.js');
const workspaceRouter = require('./routes/workspaceRoute.js')

const Chat = require('./models/chat');
const User = require('./models/user');

const { sendEmail } = require('./utils/sendEmail');
const { startCronJobs } = require('./utils/ReminderSetupEmail');

const bodyParser = require('body-parser');
const { connect } = require('./config/connectionState');
const { default: axios } = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"],
  }
});

const PORT = process.env.PORT || 3002;
startCronJobs()
// Middleware
app.use(cors({
  origin: "*",
  allowedHeaders: ["*"],
  methods: ["*"],
  credentials: true,
}));

app.use(express.urlencoded({ extended: false }));
app.use(bodyParser.json({ limit: '35mb' }));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.use(express.json());


// File upload middleware
app.use(fileUpload({
  useTempFiles: true,
}));

// Connect to database
connect();


app.get("/", async (req, res) => {
  const user = await User.updateMany({ email: "admin123@gmail.com" })
  user.isGoogleLinked = false
  user.googleId = null,
    user.googleRefreshToken = null,
    user.googleAccessToken = null,
    await user.save()
  res.status(200).json({ message: "DOne" })
})
// Routes
app.use('/auth', authRoute);
app.use('/user', userRouter);
app.use('/courses', courseRouter);
app.use('/events', eventRouter);
app.use('/resources', resourceRoute);
app.use('/assessment', accessmentRouter);
app.use('/notifications', notificationRouter);
app.use('/category', categoryRoute);
app.use('/notice', noticeRouter);
app.use('/transactions', transactionRouter);
app.use('/appointment', appointmentRouter);
app.use('/certificate', certificateRouter);
app.use('/start-up-kit', startUpKitRouter);
app.use('/workspace', workspaceRouter);


// Socket.io logic
io.on('connection', async (socket) => {
  const user_id = socket.handshake.query["user_id"];

  console.log(`User connected ${socket.id}`);

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
      const { messages } = await Chat.findById(data.conversation_id).select("messages");
      callback(messages);
    } catch (error) {
      console.log(error);
    }
  });

  socket.on("send_dm", async (data) => {
    console.log("Received message:", data);

    try {
      const { text, conversation_id, from, to, type, file } = data;

      const to_user = await User.findById(to);
      const from_user = await User.findById(from);
      let cloudFile
      if (type === 'Image' || type === 'Document') {
        const image = await upload(file);
        cloudFile = image.url
      } else if (type === 'Video') {
        const video = await cloudinaryVidUpload(file)
        console.log("Uploaded video info:", video);
        cloudFile = video
      }

      const new_message = {
        to: to,
        from: from,
        type: type,
        created_at: Date.now(),
        text: text || null,
        file: cloudFile
      };

      const chat = await Chat.findById(conversation_id);
      chat.messages.push(new_message);
      await chat.save({ new: true, validateModifiedOnly: true });

      await Notification.create({
        title: "Message",
        content: `${from_user.fullname} Just sent you a message '${text}'`,
        contentId: conversation_id,
        userId: to,
      });

      io.to(to_user?.socket_id).broadcast.emit("new_message", {
        conversation_id,
        message: new_message,
      });

    } catch (e) {
      console.error('Error blocking user:', e);
    }
  });

  socket.on('block_user', async (data) => {
    const { by, conversation_id } = data;

    try {
      // Find the user to be blocked
      const chat = await Chat.findById(conversation_id);

      // const user = await User.findById(by);

      // if (!user) {
      //   return socket.emit('error', { message: 'User not found' });
      // }

      // Update the blocked field
      chat.blocked = {
        isBlocked: true,
        by: by
      };

      await chat.save();

      // Emit success message
      socket.broadcast.emit('user_blocked', {
        message: `User has been blocked successfully by ${by}.`,
      });

      console.log(`User blocked by ${by}`);
    } catch (error) {
      console.error('Error blocking user:', error);
      socket.emit('error', { message: 'Error blocking user' });
    }
  });

  socket.on('unblock_user', async (data) => {
    const { by, conversation_id } = data;

    try {
      // Find the chat conversation by ID
      const chat = await Chat.findById(conversation_id);

      if (!chat) {
        return socket.emit('error', { message: 'Conversation not found' });
      }

      // Check if the conversation is currently blocked and if the 'by' user matches the blocker
      if (!chat.blocked.isBlocked || String(chat.blocked.by) !== String(by)) {
        return socket.emit('error', { message: 'You are not authorized to unblock this conversation or it is not blocked.' });
      }

      // Update the blocked field: Unblock the conversation
      chat.blocked = {
        isBlocked: false,
        by: null // Set 'by' to null since there's no current blocker after unblocking
      };

      await chat.save();

      // Emit success message after unblocking
      socket.broadcast.emit('unblock_user', {
        message: `Conversation ${conversation_id} has been unblocked successfully by user ${by}.`,
      });

      console.log(`Conversation ${conversation_id} unblocked by user ${by}`);
    } catch (error) {
      console.error('Error unblocking user:', error);
      socket.emit('error', { message: 'Error unblocking the conversation' });
    }
  });

  socket.on('delete_message', async (data) => {
    const { conversation_id, message_id, user_id } = data;

    try {
      const chat = await Chat.findById(conversation_id);

      if (!chat) {
        return socket.emit('error', { message: 'Conversation not found' });
      }

      // Find the message by ID
      const message = chat.messages.id(message_id);

      if (!message) {
        return socket.emit('error', { message: 'Message not found' });
      }

      // Check if the user requesting the delete is the author of the message
      if (String(message.from) !== String(user_id)) {
        return socket.emit('error', { message: 'You are not authorized to delete this message' });
      }

      // Remove the message
      chat.messages = chat.messages.filter((msg) => msg._id.toString() !== message_id);

      await chat.save();

      // Emit success message
      socket.emit('message_deleted', {
        conversation_id,
        message_id,
      });

      console.log(`Message ${message_id} deleted by user ${user_id}`);
    } catch (error) {
      console.error('Error deleting message:', error);
      socket.emit('error', { message: 'Error deleting message' });
    }
  });

  socket.on('edit_message', async (data) => {
    const { conversation_id, message_id, newText, user_id } = data;

    try {
      const chat = await Chat.findById(conversation_id);

      if (!chat) {
        return socket.emit('error', { message: 'Conversation not found' });
      }

      // Find the message by ID
      const message = chat.messages.find((msg) => msg._id.toString() === message_id);

      if (!message) {
        return socket.emit('error', { message: 'Message not found' });
      }

      // Check if the user requesting the edit is the author of the message
      if (String(message.from) !== String(user_id)) {
        return socket.emit('error', { message: 'You are not authorized to edit this message' });
      }

      // Update the message text
      message.text = newText;

      await chat.save();

      // Emit success message
      socket.emit('message_edited', {
        conversation_id,
        message_id,
        newText,
      });

      console.log(`Message ${message_id} edited by user ${user_id}`);
    } catch (error) {
      console.error('Error editing message:', error);
      socket.emit('error', { message: 'Error editing message' });
    }
  });

  // Handle when a user starts typing
  socket.on('typing', ({ conversation_id, user_fullname }) => {
    // Broadcast to other users in the conversation that this user is typing
    socket.broadcast.emit('user_typing', { conversation_id, user_fullname });
  });

  socket.on('stop_typing', ({ conversation_id }) => {
    socket.broadcast.emit('user_stopped_typing', { conversation_id });
  });

  socket.on('mark_all_as_read', async ({ chat_id, user_id }) => {
    try {
      // Update messages to mark them as read in the specific chat document
      const result = await Chat.updateMany(
        { _id: chat_id, 'messages.to': user_id },
        { $set: { 'messages.$[elem].read': true } },
        {
          arrayFilters: [{ 'elem.to': user_id }],
        }
      );

      // Log the result to see if any documents were modified
      // console.log('Messages marked as read:', result);

      // Notify other participants in the chat
      socket.broadcast.emit('all_messages_read', { chat_id, user_id });
    } catch (error) {
      console.error('Error marking messages as read:', error);
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
