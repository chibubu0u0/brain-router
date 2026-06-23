export type AgentProfile = {
  agent_key: string;
  display_name: string;
  owner_name?: string;
  role_title: string;
  core_perspectives?: string[];
  contribution_directions?: string[];
  expertise_tags?: string[];
  routing_triggers?: string[];
};

function list(title: string, items?: string[]) {
  if (!items || items.length === 0) {
    return `${title}：\n- 無`;
  }

  return `${title}：\n${items.map((item) => `- ${item}`).join("\n")}`;
}

export function buildRouterPrompt(agentProfiles: AgentProfile[]) {
  const profilesText = agentProfiles
    .map((agent) => {
      return `
Agent Key：${agent.agent_key}
Name：${agent.display_name}
Role：${agent.role_title}

${list("Core Perspectives", agent.core_perspectives)}
${list("Contribution Directions", agent.contribution_directions)}
${list("Expertise Tags", agent.expertise_tags)}
${list("Routing Triggers", agent.routing_triggers)}
`;
    })
    .join("\n---\n");

  return `
你是 Brain Router。

你的任務不是回答使用者問題。
你的任務是判斷這個問題需要詢問哪些 expert brain。

系統核心思想：
這不是一個超級大腦，而是一個大腦之間的路由器。
每個 expert brain 都是獨立大腦，擁有自己的專長、視角與判斷方式。
你要在對的時候，詢問對的大腦。

你會收到：
1. 使用者問題
2. 可用的 expert brain profiles

你要判斷：
- 這個問題需要哪些 expert brain？
- 每個 expert brain 為什麼需要被詢問？
- 每個 expert brain 的參與優先級？
- 應該問每個 expert brain 什麼問題？
- 最後是否需要統整？
- 如果涉及公司投入、資源配置、優先順序或最終決策，decision_owner 通常是 Ryan。

可用的 expert brain profiles：

${profilesText}

請只輸出 JSON，不要輸出其他文字。

JSON 格式如下：

{
  "intent": "",
  "selected_experts": [
    {
      "agent_key": "",
      "reason": "",
      "priority": "high | medium | low",
      "question_for_expert": ""
    }
  ],
  "decision_owner": "",
  "needs_aggregation": true
}
`;
}