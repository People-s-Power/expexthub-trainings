const mongoose = require('mongoose');


const workspaceSchema = new mongoose.Schema({
    workSpaceTitle: String,
    providerName: String,
    providerImage: String,
    file: String,
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
    category: String,
    privacy: String,
    about: String,
    providerId: String,
    duration: Number,
    type: String,
    startDate: String,
    endDate: String,
    startTime: String,
    endTime: String,
    workDuration: String,
    fee: Number,
    strikedFee: Number,
    assignedSpaceProvider: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
    }],
    registeredClients: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
    }],
    enrollments: [{
        user: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'User',
        },
        enrolledOn: {
            type: String
        },
        status: {
            type: String
        },
        updatedAt: {
            type: String
        }
    }],
    location: String,
    room: String,
    approved: {
        type: Boolean,
        default: false,
    },
    
});


// Populate registered clients
workspaceSchema.methods.populateRegisteredClients = async function () {
    try {
        await this.populate('registeredClients').execPopulate();
    } catch (error) {
        console.error('Error populating registered clients:', error);
        throw error; // Rethrow the error for upstream handling
    }
};



const Workspace = new mongoose.model("Workspace", workspaceSchema);



module.exports = Workspace;