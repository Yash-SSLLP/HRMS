const jwt = require('jsonwebtoken');

function generateToken(userId, role, tokenVersion = 0) {
  return jwt.sign({ id: userId, role, tokenVersion }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '1d',
  });
}

module.exports = generateToken;
