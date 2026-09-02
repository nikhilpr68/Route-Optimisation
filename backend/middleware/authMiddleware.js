const jwt = require('jsonwebtoken');
const User = require('../models/User');

const protect = async (req, res, next) => {
  let token;

  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    token = auth.split(' ')[1];
  }

  if (!token) {
    res.status(401);
    return next(new Error('Not authorized, no token'));
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id).select('-password');

    if (!user) {
      res.status(401);
      return next(new Error('Not authorized, user not found'));
    }

    req.user = user;
    return next();
  } catch (error) {
    res.status(401);
    return next(new Error('Not authorized, token failed'));
  }
};

module.exports = { protect };