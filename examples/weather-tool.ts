/**
 * Weather tool — minimal external-API integration.
 *
 * Run:
 *   export HYPERROUTER_API_KEY=hr-...
 *   export OPENWEATHER_API_KEY=...   # https://openweathermap.org/api
 *   npx tsx examples/weather-tool.ts
 */

import { callModel, tool, stepCountIs } from "@hyperrouter/agent";
import { z } from "zod";

const weatherTool = await tool({
  name: "get_weather",
  description: "Get current weather for a city by name.",
  inputSchema: z.object({
    city: z.string().describe("City name, e.g. 'Tokyo' or 'San Francisco'"),
    unit: z.enum(["celsius", "fahrenheit"]).default("celsius"),
  }),
  execute: async ({ city, unit }) => {
    const apiKey = process.env.OPENWEATHER_API_KEY;
    if (!apiKey) {
      return { error: "OPENWEATHER_API_KEY env var not set" };
    }
    const units = unit === "celsius" ? "metric" : "imperial";
    const url = `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(city)}&units=${units}&appid=${apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return { error: `Weather API returned ${res.status}` };
    const data = (await res.json()) as { main?: { temp?: number }; weather?: Array<{ description?: string }> };
    return {
      temperature: data.main?.temp,
      conditions: data.weather?.[0]?.description,
      unit: unit === "celsius" ? "°C" : "°F",
    };
  },
});

const result = callModel({
  model: "anthropic/claude-sonnet-4.6",
  messages: [
    { role: "user", content: "What's the weather in Tokyo right now? Should I bring an umbrella?" },
  ],
  tools: [weatherTool],
  stopWhen: stepCountIs(5),
});

console.log(await result.getText());
console.log("\n---");
console.log("Usage:", await result.getUsage());
