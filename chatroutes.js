const express = require("express");
const { optionalProtect } = require("../middlewares/authMiddleware");

const router = express.Router();

const {
   askChatbot
} = require("../controllers/chatController");

router.post("/", optionalProtect, askChatbot);

module.exports = router;
