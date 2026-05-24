const jwt = require("jsonwebtoken");
const mongoose = require("mongoose");
const crypto = require("crypto");
const User = require("../models/user");
const jsonDb = require("../utils/jsonDb");

let firebaseAdmin = null;

try {
  firebaseAdmin = require("firebase-admin");
  if (!firebaseAdmin.apps.length) {
    firebaseAdmin.initializeApp({
      projectId: process.env.FIREBASE_PROJECT_ID || "login-6ea19",
    });
  }
} catch (error) {
  firebaseAdmin = null;
}

const getTokenFromRequest = (req) => {
  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith("Bearer")
  ) {
    return req.headers.authorization.split(" ")[1];
  }

  return req.headers["x-auth-token"] || null;
};

const getOrCreateFirebaseUser = async (decodedToken) => {
  const email = decodedToken.email || "";
  const name = decodedToken.name || email.split("@")[0] || "Firebase User";

  if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
    let user = await User.findOne({
      $or: [{ firebaseUid: decodedToken.uid }, { email }],
    });

    if (!user) {
      user = await User.create({
        name,
        email,
        firebaseUid: decodedToken.uid,
        password: crypto.randomBytes(24).toString("hex"),
      });
    } else if (!user.firebaseUid) {
      user.firebaseUid = decodedToken.uid;
      await user.save();
    }

    return user;
  }

  const users = jsonDb.getLocalUsers();
  let user = users.find((u) => u.firebaseUid === decodedToken.uid || u.email === email);

  if (!user) {
    user = {
      _id: `firebase_user_${decodedToken.uid}`,
      name,
      email,
      firebaseUid: decodedToken.uid,
      password: await jsonDb.hashPassword(crypto.randomBytes(24).toString("hex")),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    users.push(user);
    jsonDb.saveLocalUsers(users);
  } else if (!user.firebaseUid) {
    user.firebaseUid = decodedToken.uid;
    user.updatedAt = new Date();
    jsonDb.saveLocalUsers(users);
  }

  return user;
};

const authenticateToken = async (token) => {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    if (mongoose.connection.readyState === 1 && mongoose.connection.db) {
      return await User.findById(decoded.id);
    }

    const users = jsonDb.getLocalUsers();
    return users.find((u) => u._id === decoded.id) || null;
  } catch (jwtError) {
    if (!firebaseAdmin) {
      throw jwtError;
    }

    const decodedToken = await firebaseAdmin.auth().verifyIdToken(token);
    return await getOrCreateFirebaseUser(decodedToken);
  }
};

const protect = async (req, res, next) => {
  const token = getTokenFromRequest(req);

  if (token) {
    try {
      req.user = await authenticateToken(token);

      next();

    } catch (error) {
      res.status(401).json({
        message: "Not authorized"
      });
    }

  } else {
    res.status(401).json({
      message: "No token"
    });
  }
};

const optionalProtect = async (req, res, next) => {
  const token = getTokenFromRequest(req);

  if (!token) {
    return next();
  }

  try {
    req.user = await authenticateToken(token);
  } catch (error) {
    return res.status(401).json({
      message: "Not authorized",
    });
  }

  next();
};

module.exports = { protect, optionalProtect };
