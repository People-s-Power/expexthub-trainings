const axios = require("axios").default;
const mongoose = require("mongoose");
const User = require("../models/user");
const dayjs = require("dayjs");
const weekday = require("dayjs/plugin/weekday");
const utc = require("dayjs/plugin/utc");
dayjs.extend(weekday);
dayjs.extend(utc);

const dayMap = {
  Monday: "MO", Tuesday: "TU", Wednesday: "WE",
  Thursday: "TH", Friday: "FR", Saturday: "SA", Sunday: "SU",
};

const refreshAccessToken = async (refreshToken) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;

  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });

  const { data } = await axios.post("https://oauth2.googleapis.com/token", params);
  return data;
};

const createGoogleMeet = async (
  user,
  { title, about, startDate, endDate, days, audience }
) => {
  if (!user.googleAccessToken || !user.googleRefreshToken) {
    return { success: false, message: "Google account not fully linked" };
  }

  const checked = days.filter(d => d.checked);
  const { startTime, endTime } = checked?.[0] || {};

  const start = !(checked.length > 0)
    ? new Date(startDate)
    : dayjs(`${dayjs(startDate).format("YYYY-MM-DD")}T${startTime}`);

  const end = !(checked.length > 0)
    ? new Date(endDate)
    : dayjs(`${dayjs(endDate).format("YYYY-MM-DD")}T${endTime}`);

  const recurrence = (checked && checked.length > 0)
    ? [`RRULE:FREQ=WEEKLY;BYDAY=${checked.map(d => dayMap[d.day]).join(',')};UNTIL=${dayjs(endDate).endOf('day').utc().format('YYYYMMDDTHHmmss[Z]')}`]
    : undefined;

  const attendees = audience?.length
    ? (await User.find({ _id: { $in: audience.map(id => new mongoose.Types.ObjectId(id)) } }, 'email').lean())
      .map(u => ({ email: u.email }))
    : [];

  const event = {
    summary: title,
    description: about,
    start: { dateTime: start.toISOString(), timeZone: "UTC" },
    end: { dateTime: end.toISOString(), timeZone: "UTC" },
    ...(recurrence && { recurrence }),
    attendees: [...attendees, { email: user.gMail }],
    conferenceData: {
      createRequest: {
        requestId: `meet-${Date.now()}`,
        conferenceSolutionKey: { type: "hangoutsMeet" },
      },
    },
  };

  const attemptCreateEvent = async (accessToken) => {
    return axios.post(
      "https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all",
      event,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
      }
    );
  };

  try {
    // First try with current access token
    const res = await attemptCreateEvent(user.googleAccessToken);
    return {
      success: true,
      meetLink: res.data?.hangoutLink,
      calendarEventId: res.data?.id,
    };
  } catch (err) {
    // Only retry if the error is due to access token
    const isTokenError = err.response?.status === 401;

    if (!isTokenError) {
      console.error("Google Meet creation failed:", err.response?.data || err.message);
      return { success: false, message: "Failed to create Google Meet" };
    }

    try {
      // Refresh token and retry once
      const tokenData = await refreshAccessToken(user.googleRefreshToken);
      user.googleAccessToken = tokenData.access_token;
      await user.save();

      const retryRes = await attemptCreateEvent(tokenData.access_token);
      return {
        success: true,
        meetLink: retryRes.data?.hangoutLink,
        calendarEventId: retryRes.data?.id,
      };
    } catch (retryErr) {
      console.error("Retry after token refresh failed:", retryErr.response?.data || retryErr.message);
      return { success: false, message: "Failed after refreshing token" };
    }
  }
};

module.exports = { createGoogleMeet };
