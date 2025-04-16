const axios = require("axios").default;
const mongoose = require("mongoose");
const User = require("../models/user");
const dayjs = require("dayjs");
const weekday = require('dayjs/plugin/weekday');
const utc = require('dayjs/plugin/utc');
dayjs.extend(weekday);
dayjs.extend(utc);
const dayMap = {
    Monday: "MO", Tuesday: "TU", Wednesday: "WE",
    Thursday: "TH", Friday: "FR", Saturday: "SA", Sunday: "SU",
};

const createGoogleMeet = async (
    user,
    { title, about, startDate, endDate, days, audience }
) => {
    try {
        if (!user.googleAccessToken) {
            return { success: false, message: "Google account not linked" };
        }

        const checked = days.filter(d => d.checked);
        if (!checked.length) {
            return { success: false, message: "No day selected" };
        }

        const { startTime, endTime } = checked[0];

        const start = dayjs(`${dayjs(startDate).format("YYYY-MM-DD")}T${startTime}`);
        const end = dayjs(`${dayjs(endDate).format("YYYY-MM-DD")}T${endTime}`);

        const recurrence = checked.length
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
                    conferenceSolutionKey: { type: "hangoutsMeet" }
                }
            }
        };

        const { data } = await axios.post(
            "https://www.googleapis.com/calendar/v3/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all",
            event,
            {
                headers: {
                    Authorization: `Bearer ${user.googleAccessToken}`,
                    "Content-Type": "application/json"
                }
            }
        );

        return {
            success: true,
            meetLink: data?.hangoutLink,
            calendarEventId: data?.id
        };
    } catch (err) {

        console.error("Google Meet creation error:", err.response?.data || err.message);
        return { success: false, message: "Failed to create Google Meet" };
    }
};

module.exports = { createGoogleMeet };
