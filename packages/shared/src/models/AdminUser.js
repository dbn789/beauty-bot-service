const mongoose = require('mongoose');

const adminUserSchema = new mongoose.Schema({
  login: { type: String, required: true, unique: true, index: true },
  passwordHash: { type: String, required: true },
  lastLoginAt: { type: Date, default: null },
}, { timestamps: true });

const AdminUser = mongoose.model('AdminUser', adminUserSchema);

module.exports = {
  AdminUser,
};
