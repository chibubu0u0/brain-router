const applicationId = process.env.DISCORD_APPLICATION_ID;
const botToken = process.env.DISCORD_BOT_TOKEN;
const guildId = process.env.DISCORD_GUILD_ID;

if (!applicationId) throw new Error("Missing DISCORD_APPLICATION_ID");
if (!botToken) throw new Error("Missing DISCORD_BOT_TOKEN");

const agentCommands = [
  ["brain", "讓 Brain Router 自動找適合的 AI 同事"],
  ["eric", "直接和 Eric 對話或使用 Magnific"],
  ["ryan", "直接和 Ryan 對話"],
  ["queenie", "直接和 Queenie 對話"],
];

const commands = agentCommands.map(([name, description]) => ({
  name,
  description,
  type: 1,
  options: [
    {
      name: "message",
      description: "想問這位 AI 同事的內容",
      type: 3,
      required: true,
      max_length: 1800,
    },
  ],
}));

const path = guildId
  ? `/applications/${applicationId}/guilds/${guildId}/commands`
  : `/applications/${applicationId}/commands`;

const response = await fetch(`https://discord.com/api/v10${path}`, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${botToken}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(commands),
});

const responseText = await response.text();
if (!response.ok) {
  throw new Error(`Discord command registration failed (${response.status}): ${responseText}`);
}

const registered = JSON.parse(responseText);
console.log(
  `Registered ${registered.length} Discord commands ${
    guildId ? `for guild ${guildId}` : "globally"
  }.`
);
