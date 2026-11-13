import { db } from "./db.js";

// Topics are what a hoot keeps talking about: the recurring keywords in its
// message items. No index, no model — a plain token count over the ledger,
// so the palette can answer "what have we been on about" instantly.

const MIN_TOKEN_LENGTH = 4;
const MAX_TOPICS = 40;

// Short/functional words carry no topic signal.
const STOPWORDS = new Set([
  "about", "after", "again", "against", "almost", "along", "already", "also",
  "although", "always", "among", "another", "anything", "around", "because",
  "been", "before", "being", "below", "between", "both", "cannot", "could",
  "does", "doing", "done", "down", "during", "each", "either", "else", "even",
  "ever", "every", "from", "further", "getting", "give", "going", "gone",
  "gonna", "good", "got", "have", "having", "here", "hers", "herself", "himself",
  "into", "itself", "just", "keep", "kind", "know", "last", "later", "least",
  "less", "like", "little", "look", "made", "make", "many", "may", "maybe",
  "mean", "might", "mine", "more", "most", "much", "must", "myself", "near",
  "need", "never", "next", "nice", "none", "nothing", "often", "once", "only",
  "other", "ought", "over", "own", "perhaps", "please", "plus", "probably",
  "quite", "rather", "really", "right", "said", "same", "say", "says", "seem",
  "seen", "shall", "she", "should", "since", "some", "something", "still",
  "such", "sure", "take", "than", "thank", "thanks", "that", "their", "them",
  "themselves", "then", "there", "these", "they", "thing", "things", "think",
  "this", "those", "though", "three", "through", "time", "today", "together",
  "tomorrow", "tonight", "took", "toward", "under", "until", "very", "want",
  "wanted", "was", "way", "well", "went", "were", "what", "when", "where",
  "whether", "which", "while", "who", "whom", "whose", "why", "will", "with",
  "within", "without", "would", "yeah", "your", "yours", "yourself",
]);

export type Topic = { topic: string; count: number };

function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().match(/[\p{L}][\p{L}\p{N}'’-]*/gu) ?? []) {
    const token = raw.replace(/['’-]+$/, "");
    if (token.length < MIN_TOKEN_LENGTH) continue;
    if (/^\d+$/.test(token)) continue;
    if (STOPWORDS.has(token)) continue;
    out.push(token);
  }
  return out;
}

/**
 * Recurring keywords across the hoot's message items, most frequent first.
 * `q` narrows to topics containing the fragment (palette search).
 */
export function deriveTopics(hootId: string, q?: string): Topic[] {
  const rows = db
    .prepare(
      `SELECT i.content FROM items i JOIN threads t ON t.id = i.thread_id
       WHERE t.hoot_id = ? AND i.kind = 'message'`
    )
    .all(hootId) as any[];

  const counts = new Map<string, number>();
  for (const r of rows) {
    let text = "";
    try {
      text = String(JSON.parse(r.content)?.text ?? "");
    } catch {
      text = String(r.content ?? "");
    }
    if (!text) continue;
    for (const token of tokenize(text)) counts.set(token, (counts.get(token) ?? 0) + 1);
  }

  const needle = (q ?? "").trim().toLowerCase();
  let topics = [...counts].map(([topic, count]) => ({ topic, count }));
  if (needle) topics = topics.filter((t) => t.topic.includes(needle));

  return topics.sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic)).slice(0, MAX_TOPICS);
}
