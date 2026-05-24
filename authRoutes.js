const express = require("express");
const router = express.Router();
const { body, validationResult } = require("express-validator");
const { registerUser, loginUser } = require("../controllers/authController");

// Middleware to handle validation errors and block bad requests instantly
const validateRequest = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({ errors: errors.array() });
  }
  next();
};

// @route   POST /api/auth/register
// @desc    Register user with validation rules
router.post(
  "/register",
  [
    body("name", "Name is required and cannot be empty").notEmpty().trim(),
    body("email", "Please provide a valid email address").isEmail().normalizeEmail(),
    body("password", "Password must be at least 6 characters long").isLength({ min: 6 }),
  ],
  validateRequest, // Blocks the request if the fields above fail verification
  registerUser
);

// @route   POST /api/auth/login
// @desc    Login user with validation rules
router.post(
  "/login",
  [
    body("email", "Please include a valid email").isEmail().normalizeEmail(),
    body("password", "Password is required").notEmpty(),
  ],
  validateRequest,
  loginUser
);

module.exports = router;