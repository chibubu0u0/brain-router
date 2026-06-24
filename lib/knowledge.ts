// =====================================================================
// 知識庫(RAG)核心
// 放到:lib/knowledge.ts
//
// embedTexts   :把文字轉成向量(OpenAI embeddings)
// chunkText    :把長內容切成小段
// ingestKnowledge:存原始知識 + 切塊 + embedding 寫入
// searchKnowledge:用提問做相似度檢索,撈出最相關的片段
// =====================================================================

import { supabaseAdmin } from "./supabase/server";

function getEmbeddingModel() {
  return process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
}

// 把一批文字轉成向量
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY;

  if (!apiKey) {
    throw new Error("Missing OPENAI_API_KEY");
  }

  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: getEmbeddingModel(),
      input: texts,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI embedding error: ${errorText}`);
  }

  const data = await response.json();
  return data.data.map((item: any) => item.embedding as number[]);
}

// 把長內容切成 ~800 字的小段(優先依空行/段落切)
export function chunkText(text: string, maxLen = 800): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks: string[] = [];
  let current = "";

  for (const para of paragraphs) {
    if (current && (current + "\n\n" + para).length > maxLen) {
      chunks.push(current);
      current = para;
    } else {
      current = current ? current + "\n\n" + para : para;
    }
  }

  if (current) chunks.push(current);

  // 單段仍超長就硬切
  const final: string[] = [];

  for (const chunk of chunks) {
    if (chunk.length <= maxLen) {
      final.push(chunk);
    } else {
      for (let i = 0; i < chunk.length; i += maxLen) {
        final.push(chunk.slice(i, i + maxLen));
      }
    }
  }

  if (final.length === 0 && text.trim()) {
    return [text.trim()];
  }

  return final;
}

// 存一筆知識:原文進 agent_knowledge,切塊+向量進 agent_knowledge_chunks
export async function ingestKnowledge(params: {
  agentKey: string;
  content: string;
  title?: string;
  source?: string;
  sourceRef?: string;
}): Promise<{ knowledgeId: string; chunkCount: number }> {
  const content = params.content.trim();

  if (!content) {
    throw new Error("Knowledge content is empty.");
  }

  const { data: knowledge, error: insertError } = await supabaseAdmin
    .from("agent_knowledge")
    .insert({
      agent_key: params.agentKey,
      source: params.source || "manual",
      source_ref: params.sourceRef || null,
      title: params.title || content.slice(0, 60),
      content,
    })
    .select("id")
    .single();

  if (insertError || !knowledge) {
    throw new Error(`Insert knowledge error: ${insertError?.message}`);
  }

  const chunks = chunkText(content);
  const embeddings = await embedTexts(chunks);

  const rows = chunks.map((chunk, i) => ({
    knowledge_id: knowledge.id,
    agent_key: params.agentKey,
    chunk_text: chunk,
    // 以 JSON 陣列字串寫入,pgvector 會自動解析
    embedding: JSON.stringify(embeddings[i]),
  }));

  const { error: chunkError } = await supabaseAdmin
    .from("agent_knowledge_chunks")
    .insert(rows);

  if (chunkError) {
    throw new Error(`Insert chunks error: ${chunkError.message}`);
  }

  return { knowledgeId: knowledge.id, chunkCount: chunks.length };
}

// 用提問檢索某個 agent 最相關的知識片段
export async function searchKnowledge(params: {
  agentKey: string;
  query: string;
  matchCount?: number;
}): Promise<{ chunk_text: string; similarity: number }[]> {
  const query = params.query.trim();

  if (!query) return [];

  try {
    const [embedding] = await embedTexts([query]);

    const { data, error } = await supabaseAdmin.rpc(
      "match_agent_knowledge_chunks",
      {
        p_agent_key: params.agentKey,
        p_query_embedding: JSON.stringify(embedding),
        p_match_count: params.matchCount || 5,
      }
    );

    if (error) return [];

    return (data as { chunk_text: string; similarity: number }[]) || [];
  } catch {
    // 檢索失敗不應讓整個對話掛掉
    return [];
  }
}
