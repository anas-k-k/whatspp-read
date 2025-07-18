const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
require("dotenv").config();
const { OpenAI } = require("openai");

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
const promptPath = path.join(
  __dirname,
  "..",
  "Udemy-Training",
  "Lab1",
  "chembys_system_prompt.txt"
);
const systemPrompt = fs.readFileSync(promptPath, "utf8");

// Prepare OpenAI client once
const geminiApiKey = process.env.GEMINI_API_KEY;
const openai = geminiApiKey
  ? new OpenAI({
      apiKey: geminiApiKey,
      baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
    })
  : null;

// In-memory chat history per user
const chatHistories = {};

client.on("message", async (message) => {
  console.log("--- New message received ---");
  console.log(`From: ${message.from}`);
  console.log(`To: ${message.to}`);
  console.log(`Body: ${message.body}`);
  // Only reply if sender is in the allowed numbers list
  const allowedNumbers = ["919847168947", "919207489258", "919995320423"];
  const isAllowed = allowedNumbers.some((num) =>
    message.from.startsWith(num + "@")
  );
  if (isAllowed) {
    try {
      const chat = await message.getChat();
      console.log(`Chat type: ${chat.isGroup ? "Group" : "Private"}`);

      if (!geminiApiKey || !openai) {
        await message.reply(
          "Gemini API Key not set. Please check server config."
        );
        return;
      }

      // Get customer display name
      const contact = await message.getContact();
      const customerName = contact.pushname || contact.name || contact.number;
      console.log(`Extracted customer name: ${customerName}`);

      // Maintain chat history for this user, with personalized system prompt
      const userKey = message.from;
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
          model: "gemini-2.0-flash",
          messages: chatHistories[userKey],
        });
        llmResponse = response.choices[0].message.content;
        // Add assistant reply to history
        chatHistories[userKey].push({
          role: "assistant",
          content: llmResponse,
        });
      } catch (llmErr) {
        console.error("Error from LLM:", llmErr);
        await message.reply("Sorry, there was an error generating a response.");
        return;
      }

      // Reply with LLM response
      await message.reply(llmResponse);
    } catch (err) {
      console.error("Error while replying:", err);
    }
  } else {
    console.log("Not a direct chat. No reply sent.");
  }
});

// Start the client
client.initialize();
