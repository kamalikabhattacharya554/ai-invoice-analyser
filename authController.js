const mongoose = require("mongoose");
const User = require("../models/user");
const generateToken = require("../utils/generateToken");
const jsonDb = require("../utils/jsonDb");

// @desc    Register a new user
// @route   POST /api/auth/register
const registerUser = async (req, res) => {
  try {
    const { name, email, password } = req.body;

    // 1. Input Validation: Guard against missing incoming body fields
    if (!name || !email || !password) {
      return res.status(400).json({ 
        message: "Please provide all required fields: name, email, and password." 
      });
    }

    const runOfflineRegister = async () => {
      const users = jsonDb.getLocalUsers();
      const userExists = users.find((u) => u.email.toLowerCase() === email.toLowerCase());
      if (userExists) {
        return res.status(400).json({
          message: "User already exists"
        });
      }

      const hashedPassword = await jsonDb.hashPassword(password);
      const user = {
        _id: `offline_user_${Date.now()}`,
        name,
        email,
        password: hashedPassword,
        createdAt: new Date(),
        updatedAt: new Date()
      };

      users.push(user);
      jsonDb.saveLocalUsers(users);

      return res.status(201).json({
        _id: user._id,
        name: user.name,
        email: user.email,
        token: generateToken(user._id)
      });
    };

    // If database connection is clearly offline, run offline register
    if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
      return await runOfflineRegister();
    }

    try {
      // 2. Check if user already exists
      const userExists = await User.findOne({ email });
      if (userExists) {
        return res.status(400).json({
          message: "User already exists"
        });
      }

      // 3. Create the user record (Password hashing happens in the model pre-save middleware)
      const user = await User.create({
        name,
        email,
        password
      });

      // 4. Return user profile metadata alongside active JWT authorization token
      return res.status(201).json({
        _id: user._id,
        name: user.name,
        email: user.email,
        token: generateToken(user._id)
      });
    } catch (dbError) {
      const isConnectionErr = dbError.name === "MongooseError" || 
                              dbError.message.includes("bufferCommands") || 
                              dbError.message.includes("connection") ||
                              dbError.message.includes("findOne");
      if (isConnectionErr) {
        console.warn("Mongoose register query failed during startup/offline. Falling back to local JSON database.");
        return await runOfflineRegister();
      }
      throw dbError; // Rethrow actual validation/duplicate errors
    }

  } catch (error) {
    console.error("Registration Server Error:", error);
    res.status(500).json({ 
      message: "Server encountered an error creating your profile.", 
      error: error.message 
    });
  }
};

// @desc    Authenticate user & get token
// @route   POST /api/auth/login
const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;

    // 1. Input Validation: Ensure login payloads aren't blank strings
    if (!email || !password) {
      return res.status(400).json({ 
        message: "Please enter both an email and password to log in." 
      });
    }

    const runOfflineLogin = async () => {
      const users = jsonDb.getLocalUsers();
      const user = users.find((u) => u.email.toLowerCase() === email.toLowerCase());

      if (user && (await jsonDb.comparePassword(password, user.password))) {
        return res.json({
          _id: user._id,
          name: user.name,
          email: user.email,
          token: generateToken(user._id)
        });
      } else {
        return res.status(401).json({
          message: "Invalid credentials"
        });
      }
    };

    // If database connection is clearly offline, run offline login
    if (mongoose.connection.readyState !== 1 || !mongoose.connection.db) {
      return await runOfflineLogin();
    }

    try {
      // 2. Locate user profile document
      const user = await User.findOne({ email }).select("+password");

      // 3. Verify security match thresholds
      if (user && (await user.matchPassword(password))) {
        return res.json({
          _id: user._id,
          name: user.name,
          email: user.email,
          token: generateToken(user._id)
        });
      } else {
        return res.status(401).json({
          message: "Invalid credentials"
        });
      }
    } catch (dbError) {
      const isConnectionErr = dbError.name === "MongooseError" || 
                              dbError.message.includes("bufferCommands") || 
                              dbError.message.includes("connection") ||
                              dbError.message.includes("findOne");
      if (isConnectionErr) {
        console.warn("Mongoose login query failed during startup/offline. Falling back to local JSON database.");
        return await runOfflineLogin();
      }
      throw dbError;
    }

  } catch (error) {
    console.error("Login Server Error:", error);
    res.status(500).json({ 
      message: "Server encountered an error processing your login request.", 
      error: error.message 
    });
  }
};

module.exports = {
  registerUser,
  loginUser
};
