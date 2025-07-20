const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");
const yaml = require("js-yaml");
require("dotenv").config({ override: true });
const { OpenAI } = require("openai");
const readline = require("readline");

// Ensure logs directory exists
const logsDir = path.join(__dirname, "logs");
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir);
}

// Override console.log to also write to a daily log file
const originalConsoleLog = console.log;
console.log = function (...args) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const logFile = path.join(logsDir, `${dateStr}.txt`);
  const logLine =
    `[${now.toISOString()}] ` +
    args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ") +
    "\n";
  // Write to file (append)
  fs.appendFileSync(logFile, logLine);
  // Also output to original console
  originalConsoleLog.apply(console, args);
};

// Import templates for identifier replacement
const templates = require("./template.js");

// Write errors to a daily error log file in logs folder
function writeErrorLog(prefix, err) {
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const errorLogFile = path.join(logsDir, `${dateStr}.error.txt`);
  const logLine = `[${now.toISOString()}] ${prefix}: ${
    err && err.stack ? err.stack : err
  }\n`;
  fs.appendFileSync(errorLogFile, logLine);
}

process.on("uncaughtException", (err) => {
  writeErrorLog("Uncaught", err);
});
process.on("unhandledRejection", (err) => {
  writeErrorLog("Unhandled", err);
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

// Handle disconnects and attempt to reconnect
client.on("disconnected", (reason) => {
  console.error(`Client disconnected. Reason: ${reason}`);
  // Wait 5 seconds before attempting to re-initialize
  setTimeout(() => {
    console.log(
      "Attempting to re-initialize WhatsApp client after disconnect..."
    );
    client.initialize();
  }, 5000);
});

// Load system prompt from YAML and flatten to string
const promptPath = path.join(__dirname, "prompts", "chembys_system_prompt.txt");
const systemPrompt = yamlToText(promptPath);

// --- LLM Provider Selection ---
let apiProvider = "openai";
let llmConfig = {};
let openai = null;

function promptProvider() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(
      "Which API to use? (openai/ollama/gemini) [default: openai]: ",
      (answer) => {
        rl.close();
        const val = answer.trim().toLowerCase();
        if (["openai", "ollama", "gemini"].includes(val)) {
          resolve(val);
        } else {
          resolve("openai");
        }
      }
    );
  });
}

async function setupLlmProvider() {
  apiProvider = await promptProvider();
  if (apiProvider === "ollama") {
    llmConfig = {
      baseUrl: process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
      apiKey: process.env.OLLAMA_API_KEY || "ollama",
      model: process.env.OLLAMA_MODEL || "llama3.2:latest",
    };
    openai = new OpenAI({
      apiKey: llmConfig.apiKey,
      baseURL: llmConfig.baseUrl,
    });
    console.log(
      `Using Ollama (OpenAI compatible): ${llmConfig.baseUrl}, model: ${llmConfig.model}`
    );
  } else if (apiProvider === "gemini") {
    llmConfig = {
      baseUrl:
        process.env.GEMINI_BASE_URL ||
        "https://generativelanguage.googleapis.com/v1beta/openai/",
      apiKey: process.env.GEMINI_API_KEY,
      model: process.env.GEMINI_MODEL || "gemini-pro",
    };
    openai = new OpenAI({
      apiKey: llmConfig.apiKey,
      baseURL: llmConfig.baseUrl,
    });
    console.log(
      `Using Gemini (OpenAI compatible): ${llmConfig.baseUrl}, model: ${llmConfig.model}`
    );
  } else {
    llmConfig = {
      baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
      apiKey: process.env.OPENAI_API_KEY,
      model: process.env.OPENAI_MODEL || "gpt-3.5-turbo",
    };
    openai = llmConfig.apiKey
      ? new OpenAI({
          apiKey: llmConfig.apiKey,
          baseURL: llmConfig.baseUrl,
        })
      : null;
    console.log(
      `Using OpenAI: ${llmConfig.baseUrl}, model: ${llmConfig.model}`
    );
  }
}

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
  // console.log(`Chat type: ${chat.isGroup ? "Group" : "Private"}`);
  if (!chat.isGroup) {
    // Show typing indication as early as possible
    let typingStarted = false;
    try {
      await chat.sendStateTyping();
      typingStarted = true;
      if (!llmConfig.apiKey || (apiProvider === "openai" && !openai)) {
        if (typingStarted) await chat.clearState();
        await message.reply(
          `${
            apiProvider === "ollama" ? "Ollama" : "OpenAI"
          } API Key not set. Please check server config.`
        );
        return;
      }

      // Get customer display name
      const contact = await message.getContact();
      const customerName = contact.pushname || contact.name || contact.number;
      // console.log(`Extracted customer name: ${customerName}`);

      // Maintain chat history for this user, with personalized system prompt
      const userKey = message.from;
      // Update last activity timestamp for this user
      lastActivity[userKey] = Date.now();

      if (!chatHistories[userKey]) {
        // FIRST INTERACTION: reply with GREETING_TEMPLATE and initialize chat history
        const greetingRaw = templates.GREETING_TEMPLATE
          ? templates.GREETING_TEMPLATE(customerName, templates.PRODUCT_LIST)
          : `Hi ${customerName}`;
        const greeting = toWhatsAppMarkdown(greetingRaw);
        if (typingStarted) await chat.clearState();
        await message.reply(greeting);
        // Initialize chat history for future interactions
        const personalizedPrompt = systemPrompt.replace(
          /\[Customer Name\]/g,
          customerName
        );
        chatHistories[userKey] = [
          { role: "system", content: personalizedPrompt },
          {
            role: "user",
            content: `${message.body} (Customer Name: ${customerName})`,
          },
          { role: "assistant", content: greetingRaw },
        ];
        return;
      }

      // Add user message, appending customer name for LLM context
      chatHistories[userKey].push({
        role: "user",
        content: `${message.body} (Customer Name: ${customerName})`,
      });

      // Call LLM with full history
      let llmResponse;
      try {
        // All providers now use OpenAI-compatible API
        const response = await openai.chat.completions.create({
          model: llmConfig.model,
          messages: chatHistories[userKey],
          temperature: 0,
        });
        llmResponse = response.choices[0].message.content;
        console.log("LLM response:", llmResponse);

        // Replace placeholders for outgoing reply only
        llmResponse = replacePlaceholders(llmResponse);

        // Add LLM response to chat history
        chatHistories[userKey].push({
          role: "assistant",
          content: llmResponse,
        });
      } catch (llmErr) {
        console.error("Error from LLM:", llmErr);
        if (typingStarted) await chat.clearState();
        await message.reply("Sorry, there was an error generating a response.");
        return;
      }

      // Reply with LLM response, sanitized for WhatsApp Markdown
      if (typingStarted) await chat.clearState();
      await message.reply(toWhatsAppMarkdown(llmResponse));
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

// Main startup

(async () => {
  await setupLlmProvider();
  console.log("[DEBUG] Calling client.initialize()...");
  try {
    client.initialize();
    console.log("[DEBUG] client.initialize() called");
  } catch (initErr) {
    console.error("[ERROR] Exception during client.initialize():", initErr);
  }
})();

// Extra event logging for WhatsApp client
client.on("auth_failure", (msg) => {
  console.error("[ERROR] Authentication failure:", msg);
});
client.on("change_state", (state) => {
  console.log(`[DEBUG] Client state changed: ${state}`);
});
client.on("loading_screen", (percent, message) => {
  console.log(`[DEBUG] Loading screen: ${percent}% - ${message}`);
});
client.on("error", (err) => {
  console.error("[ERROR] WhatsApp client error:", err);
});
client.on("ws_close", (reason) => {
  console.error("[ERROR] WhatsApp WebSocket closed:", reason);
});
client.on("authenticated", (session) => {
  console.log("[DEBUG] WhatsApp client authenticated.");
});
client.on("ready", () => {
  console.log("[DEBUG] WhatsApp client ready event fired.");
});

// Keep process alive (prevent early exit)
setInterval(() => {}, 1000 * 60 * 60);

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

// Function to replace placeholders in LLM response with values from template.js
function replacePlaceholders(text) {
  if (!text) return text;
  // Replace GREETING_TEMPLATE: {{GREETING_TEMPLATE:CustomerName}} and {{GREETING_TEMPLATE}}
  text = text.replace(
    /\{\{GREETING_TEMPLATE(?::([^}]*))?\}\}/g,
    (match, customerName) => {
      if (typeof templates.GREETING_TEMPLATE === "function") {
        if (typeof customerName === "string") {
          return templates.GREETING_TEMPLATE(customerName.trim() || undefined);
        } else {
          return templates.GREETING_TEMPLATE();
        }
      }
      return match;
    }
  );
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

// Sanitize/convert Markdown to WhatsApp-supported formatting
function toWhatsAppMarkdown(text) {
  if (!text) return text;
  // Remove unsupported Markdown: headings, links, images, tables, code blocks
  // Remove headings (e.g., # Heading)
  text = text.replace(/^#+\s+/gm, "");
  // Convert links [text](url) to just text (or text: url)
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1: $2");
  // Remove images ![alt](url)
  text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, "");
  // (Removed) Do not strip table rows, so table-like content is preserved
  // Convert triple backtick code blocks to monospace (single backtick per line)
  text = text.replace(/```([\s\S]*?)```/g, (match, code) => {
    return code
      .split("\n")
      .map((line) => "`" + line.trim() + "`")
      .join("\n");
  });
  // Remove extra asterisks or underscores not used for formatting
  // (optional, can be refined if needed)
  return text;
}

function yamlToText(filePath) {
  const yamlData = yaml.load(fs.readFileSync(filePath, "utf8"));

  // Simple flattening logic (customize based on your YAML structure)
  let text = "";
  for (const key in yamlData) {
    if (typeof yamlData[key] === "string") {
      text += `${yamlData[key]}\n\n`;
    } else if (Array.isArray(yamlData[key])) {
      text += yamlData[key].join("\n") + "\n\n";
    } else if (typeof yamlData[key] === "object") {
      for (const subkey in yamlData[key]) {
        text += `${yamlData[key][subkey]}\n\n`;
      }
    }
  }
  return text.trim();
}

// --- TEST: verify GREETING_TEMPLATE replacement ---
if (process.env.TEST_GREETING_TEMPLATE === "1") {
  const test1 = replacePlaceholders("{{GREETING_TEMPLATE:John Doe}}\n");
  const test2 = replacePlaceholders("{{GREETING_TEMPLATE:}}\n");
  const test3 = replacePlaceholders("{{GREETING_TEMPLATE}}\n");
  console.log("Test GREETING_TEMPLATE with name:", test1);
  console.log("Test GREETING_TEMPLATE with empty:", test2);
  console.log("Test GREETING_TEMPLATE with no arg:", test3);
}
