// "Propose a promise": one model call that turns a sentence ("every weekday
// at 7, nudge me to stretch") into a draft automation the user can accept.
// The model never writes to the db — the caller decides — and the RRULE it
// returns is validated by actually computing the next fire.
import OpenAI from "openai";
import { db, now } from "./db.js";
import { config } from "./config.js";
import { logOutbound } from "./outbound.js";
import { computeNextFire } from "./scheduler.js";

const PROPOSAL_MODEL = "glm-5.3-flash-uncensored";
const MAX_FACTS = 40;

export type Proposal = {
  title: string;
  prompt: string;
  rrule: string;
  times: string[];
  assumptions: string[];
  conflicts: { fact: string; time: string }[];
};

export class ProposalError extends Error {
  status: number;
  constructor(message: string, status = 502) {
    super(message);
    this.status = status;
  }
}

const localZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

function nowInLocalZone(): string {
  const d = new Date(now());
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${stamp} ${d.toLocaleDateString("en-US", { weekday: "long" })} (${localZone()})`;
}

// Strip code fences and any prose the model wrapped the object in.
function parseJson(raw: string): any | null {
  const s = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try {
    return JSON.parse(s);
  } catch {
    // fall through
  }
  const a = s.indexOf("{");
  const b = s.lastIndexOf("}");
  if (a >= 0 && b > a) {
    try {
      return JSON.parse(s.slice(a, b + 1));
    } catch {
      // fall through
    }
  }
  return null;
}

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x)).filter((x) => x.trim()) : [];

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

function normalize(parsed: any): Proposal | null {
  const title = str(parsed?.title);
  const prompt = str(parsed?.prompt);
  const rrule = str(parsed?.rrule);
  if (!title || !prompt || !rrule) return null;
  const conflicts = Array.isArray(parsed?.conflicts)
    ? parsed.conflicts
        .map((c: any) => ({ fact: str(c?.fact), time: str(c?.time) }))
        .filter((c: { fact: string }) => c.fact)
    : [];
  return {
    title,
    prompt,
    rrule,
    times: strList(parsed?.times),
    assumptions: strList(parsed?.assumptions),
    conflicts,
  };
}

function hootFacts(hootId: string): string[] {
  return (
    db
      .prepare(
        `SELECT text FROM facts WHERE forgotten_at IS NULL AND (hoot_id = ? OR scope = 'global')
         ORDER BY created_at DESC LIMIT ${MAX_FACTS}`
      )
      .all(hootId) as any[]
  ).map((r) => String(r.text));
}

const SYSTEM = [
  "You turn a person's sentence into one scheduled agent promise.",
  "Reply with ONLY a JSON object of the shape:",
  '{"title": string, "prompt": string, "rrule": string, "times": string[], "assumptions": string[], "conflicts": [{"fact": string, "time": string}]}',
  '- "title": 2-4 words, what the promise is.',
  '- "prompt": the instruction the agent gets when it fires, second person, self-contained.',
  '- "rrule": RFC 5545 RRULE text, no DTSTART, e.g. "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;BYHOUR=7;BYMINUTE=0;BYSECOND=0". Use the local wall clock of the given timezone.',
  '- "times": the local wall-clock times implied, "HH:MM".',
  '- "assumptions": what you had to guess, short. Empty when nothing was guessed.',
  '- "conflicts": known facts that the requested time collides with; "fact" is the fact text, "time" the colliding time.',
  "Reply with JSON only, no prose.",
].join("\n");

async function attempt(client: OpenAI, payload: string): Promise<Proposal & { nextFire: number }> {
  logOutbound("model", "promise proposal", payload.length);
  const res = await client.chat.completions.create({
    model: PROPOSAL_MODEL,
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: payload },
    ],
    temperature: 0.2,
  });
  const proposal = normalize(parseJson(res.choices[0]?.message?.content ?? ""));
  if (!proposal) throw new Error("unparseable promise proposal");
  const nextFire = computeNextFire(proposal.rrule, localZone(), now());
  if (nextFire == null) throw new Error("proposal rrule does not fire");
  return { ...proposal, nextFire };
}

/** Draft a promise from `text`. Throws ProposalError(502) if the model fails twice. */
export async function proposePromise(hootId: string, text: string): Promise<Proposal & { nextFire: number }> {
  if (!config.openaiApiKey) throw new ProposalError("no model key configured", 502);

  const payload = JSON.stringify({
    request: text,
    now: nowInLocalZone(),
    timezone: localZone(),
    facts: hootFacts(hootId),
  });
  const client = new OpenAI({ baseURL: config.openaiBaseUrl, apiKey: config.openaiApiKey });

  let lastErr: unknown = null;
  for (let i = 0; i < 2; i++) {
    try {
      return await attempt(client, payload);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new ProposalError(`promise proposal failed: ${String((lastErr as any)?.message ?? lastErr)}`, 502);
}
