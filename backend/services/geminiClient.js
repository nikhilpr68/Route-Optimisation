// backend/services/geminiClient.js
const { GoogleGenAI } = require('@google/genai');

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing GEMINI_API_KEY in environment');
  }
  return new GoogleGenAI({ apiKey });
}

module.exports = { getGeminiClient };