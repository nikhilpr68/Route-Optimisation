const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const SubscriptionSchema = new mongoose.Schema({
  provider: { type: String, trim: true, default: 'razorpay' },
  customerId: { type: String, trim: true, default: '' },
  subscriptionId: { type: String, trim: true, default: '' },
  planId: { type: String, trim: true, default: '' },
  authPaymentId: { type: String, trim: true, default: '' },
  status: { type: String, trim: true, default: 'inactive' },
  currentPeriodEnd: { type: Date, default: null },
  endedAt: { type: Date, default: null },
  cancelAtPeriodEnd: { type: Boolean, default: false }
}, { _id: false });

const UserSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  password: { type: String, required: true, minlength: 8 },
  profileImage: { type: String, default: '' },
  role: {
    type: String,
    enum: ['Admin', 'Manager', 'Viewer'],
    default: 'Manager'
  },
  planTier: {
    type: String,
    enum: ['free', 'premium'],
    default: 'free'
  },
  subscription: {
    type: SubscriptionSchema,
    default: () => ({})
  },
  createdAt: { type: Date, default: Date.now }
});

// ✅ Promise-style async hook: NO next()
UserSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password, salt);
});

UserSchema.methods.matchPassword = async function (enteredPassword) {
  return bcrypt.compare(enteredPassword, this.password);
};

module.exports = mongoose.model('User', UserSchema);
