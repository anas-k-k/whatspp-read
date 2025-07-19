const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const { OpenAI } = require("openai");

// Import templates for identifier replacement
const templates = require("./template.js");

// Function to replace placeholders in LLM response with values from template.js
function replacePlaceholders(text) {
  if (!text) return text;
  // Replace simple placeholders: {{IDENTIFIER}}
  text = text.replace(/\{\{([A-Z_]+)\}\}/g, (match, key) => {
    if (typeof templates[key] === "string") {
      return templates[key];
    }
    return match;
  });
  // Replace PINCODE_MISMATCH: {{PINCODE_MISMATCH:CityName}}
  text = text.replace(/\{\{PINCODE_MISMATCH:([^}]+)\}\}/g, (match, city) => {
    if (typeof templates.PINCODE_MISMATCH === "function") {
      return templates.PINCODE_MISMATCH(city.trim());
    }
    return match;
  });
  // Replace ORDER_CONFIRM: {{ORDER_CONFIRM:{...}}}
  text = text.replace(/\{\{ORDER_CONFIRM:({[^}]+})\}\}/g, (match, jsonStr) => {
    try {
      const obj = JSON.parse(jsonStr);
      if (typeof templates.ORDER_CONFIRM === "function") {
        return templates.ORDER_CONFIRM(obj);
      }
    } catch (e) {
      return match;
    }
    return match;
  });
  return text;
}

const logStream = fs.createWriteStream("app.log", { flags: "a" });
process.on("uncaughtException", (err) => {
  logStream.write(
    `[${new Date().toISOString()}] Uncaught: ${err.stack || err}\n`
  );
});
process.on("unhandledRejection", (err) => {
  logStream.write(
    `[${new Date().toISOString()}] Unhandled: ${err.stack || err}\n`
  );
});

// Create a new client instance with persistent authentication
const client = new Client({
  authStrategy: new LocalAuth(),
});

// Display QR code in terminal for authentication
client.on("qr", (qr) => {
  console.log("QR code received. Scan this with your WhatsApp app:");
  qrcode.generate(qr, { small: true });
});

// Log when client is ready
client.on("ready", () => {
  console.log(
    "Client is ready! You should now be able to send and receive messages."
  );
});

// Load system prompt once
const promptPath = path.join(__dirname, "prompts", "chembys_system_prompt.txt");
const systemPrompt = fs.readFileSync(promptPath, "utf8");

// Prepare OpenAI client once
const openApiKey = process.env.OPENAI_API_KEY;
const openai = openApiKey
  ? new OpenAI({
      apiKey: openApiKey,
      baseURL: "https://api.openai.com/v1",
    })
  : null;

// In-memory chat history per user
const chatHistories = {};
// Track last activity timestamp per user
const lastActivity = {};

client.on("message", async (message) => {
  console.log("--- New message received ---");
  console.log(`From: ${message.from}`);
  console.log(`To: ${message.to}`);
  console.log(`Body: ${message.body}`);
  // Only reply if chat type is personal (not group)
  const chat = await message.getChat();
  console.log(`Chat type: ${chat.isGroup ? "Group" : "Private"}`);
  if (!chat.isGroup) {
    // Show typing indication as early as possible
    let typingStarted = false;
    try {
      await chat.sendStateTyping();
      typingStarted = true;
      if (!openApiKey || !openai) {
        if (typingStarted) await chat.clearState();
        await message.reply(
          "OpenAI API Key not set. Please check server config."
        );
        return;
      }

      // Get customer display name
      const contact = await message.getContact();
      const customerName = contact.pushname || contact.name || contact.number;
      console.log(`Extracted customer name: ${customerName}`);

      // Maintain chat history for this user, with personalized system prompt
      const userKey = message.from;
      // Update last activity timestamp for this user
      lastActivity[userKey] = Date.now();
      if (!chatHistories[userKey]) {
        // Replace [Customer Name] in the system prompt
        const personalizedPrompt = systemPrompt.replace(
          /\[Customer Name\]/g,
          customerName
        );
        chatHistories[userKey] = [
          { role: "system", content: personalizedPrompt },
        ];
      }
      // Add user message, appending customer name for LLM context
      chatHistories[userKey].push({
        role: "user",
        content: `${message.body} (Customer Name: ${customerName})`,
      });

      // Call LLM with full history
      let llmResponse;
      try {
        const response = await openai.chat.completions.create({
          model: "gpt-4-1106-preview",
          messages: chatHistories[userKey],
        });
        llmResponse = response.choices[0].message.content;
        // Add assistant reply to history (keep original, with identifiers)
        chatHistories[userKey].push({
          role: "assistant",
          content: llmResponse,
        });
        // Replace placeholders for outgoing reply only
        llmResponse = replacePlaceholders(llmResponse);
      } catch (llmErr) {
        console.error("Error from LLM:", llmErr);
        if (typingStarted) await chat.clearState();
        await message.reply("Sorry, there was an error generating a response.");
        return;
      }

      // Reply with LLM response
      if (typingStarted) await chat.clearState();
      await message.reply(llmResponse);
    } catch (err) {
      console.error("Error while replying:", err);
      try {
        if (typingStarted) await chat.clearState();
      } catch (e) {}
    }
  } else {
    console.log("Not a direct chat. No reply sent.");
  }
});

// Start the client
client.initialize();

// Periodically clear chat history for inactive users (every 1 minute)
setInterval(() => {
  const now = Date.now();
  const INACTIVITY_LIMIT = 10 * 60 * 1000; // 10 minutes in ms
  for (const userKey in lastActivity) {
    if (lastActivity.hasOwnProperty(userKey)) {
      if (now - lastActivity[userKey] > INACTIVITY_LIMIT) {
        console.log(`Clearing chat history for inactive user: ${userKey}`);
        delete chatHistories[userKey];
        delete lastActivity[userKey];
      }
    }
  }
}, 60 * 1000); // Run every 1 minute
