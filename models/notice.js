const mongoose = require('mongoose');


const noticeSchema = new mongoose.Schema({
  role: String,
  category: String,
  country: String,
  state: String,
  title: String,
  body: String,
  link: String,
  page: String,
  cancel: Boolean,
  action: String,
  triggerPage: String,
  thumbnail: {
    type: {
      type: String,
      required: true
    },
    url: {
      type: String,
      required: true
    }
  },
  receivers: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
  viewed: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
  }],
})



const Notice = new mongoose.model("Notice", noticeSchema);


module.exports = Notice;