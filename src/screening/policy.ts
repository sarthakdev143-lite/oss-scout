/**
 * Contribution-policy screening: AI/LLM policy classification and contributing rules
 * (sign-off, CLA, issue-first, good-first-issue reservation). Pure functions over fetched documents.
 *
 * The AI classifier is regex based (validated against ~35 real policies, see docs/ARCHITECTURE.md):
 * sentences inside AI-policy sections, plus sentences anywhere that mention AI, are matched against
 * pattern families; the most restrictive verdict wins:
 *   prohibited > restricted > disclosure_required > allowed > unclear > none_found.
 * Repository text is untrusted data: it is only matched, never followed.
 */
import type { AiPolicyClass, AiPolicyResult, CommitConvention, PolicyEvidence, RepoPolicy } from "../core/types.ts"
import type { GhRepo } from "../github/types.ts"

export interface PolicyDoc {
  path: string
  text: string
}

/**
 * Repo-relative paths fetched (if present) when screening a repo's contribution/AI policy, in priority
 * order. screen.ts matches them case-insensitively against directory listings and also picks up other
 * AI-policy-named files (see AI_POLICY_FILE_RE) and CONTRIBUTING/CODE_OF_CONDUCT extension variants.
 */
export const POLICY_DOC_PATHS: readonly string[] = [
  "AI_POLICY.md",
  ".github/AI_POLICY.md",
  "docs/AI_POLICY.md",
  ".github/CONTRIBUTING.md",
  "CONTRIBUTING.md",
  "docs/CONTRIBUTING.md",
  "CONTRIBUTING.rst",
  ".github/CODE_OF_CONDUCT.md",
  "CODE_OF_CONDUCT.md",
  "AGENTS.md",
  ".github/copilot-instructions.md",
  "README.md",
]

/** PR template locations, in priority order (matched case-insensitively). */
export const PR_TEMPLATE_PATHS: readonly string[] = [
  ".github/pull_request_template.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "pull_request_template.md",
  "PULL_REQUEST_TEMPLATE.md",
  "docs/pull_request_template.md",
  "docs/PULL_REQUEST_TEMPLATE.md",
]

/** Directories that may hold several PR templates (GitHub's `?template=` mechanism). */
export const PR_TEMPLATE_DIRS: readonly string[] = [
  ".github/PULL_REQUEST_TEMPLATE",
  "PULL_REQUEST_TEMPLATE",
  "docs/PULL_REQUEST_TEMPLATE",
]

/** Max characters kept in RepoPolicy.contributingExcerpt. */
export const CONTRIBUTING_EXCERPT_CHARS = 6000
/** Max characters kept in RepoPolicy.prTemplate. */
export const PR_TEMPLATE_CHARS = 10_000
/** Max characters per evidence excerpt. */
export const EVIDENCE_EXCERPT_CHARS = 300

// ---------------------------------------------------------------------------
// Document kinds
// ---------------------------------------------------------------------------

export type PolicyDocKind = "ai_policy" | "contributing" | "code_of_conduct" | "agents" | "readme" | "pr_template"

/** Files whose whole body is an AI policy (no AI heading needed). */
export const AI_POLICY_FILE_RE =
  /(^|\/)(ai[-_ ]?(policy|usage[-_]policy|contributing|covenant|agreement|guidelines)|ai|howtoai|llm[-_]?polic(y|ies)|generative[-_]ai[-_]policy|no[-_]llm[-_]tools|ai[-_]tool[-_]policy|aitoolpolicy|aiagreement)\.(md|markdown|rst|txt|adoc)$/i

const DOC_EXT = String.raw`(?:\.(?:md|markdown|rst|txt|adoc))?`
const CONTRIBUTING_NAME_RE = new RegExp(`^contributing${DOC_EXT}$`, "i")
const COC_NAME_RE = new RegExp(`^code[_-]of[_-]conduct${DOC_EXT}$`, "i")
const AGENTS_NAME_RE = /^(agents\.md|copilot-instructions\.md)$/i
const README_NAME_RE = /^readme(?:\.(?:md|markdown|rst|txt))?$/i
const PR_TEMPLATE_NAME_RE = /^pull_request_template\.(?:md|markdown|txt)$/i

function baseName(path: string): string {
  const p = path.replace(/\\/g, "/")
  return p.slice(p.lastIndexOf("/") + 1)
}

/** What kind of policy document a path is (by file name), or null. */
export function policyDocKind(path: string): PolicyDocKind | null {
  const p = path.replace(/\\/g, "/")
  const name = baseName(p)
  if (PR_TEMPLATE_NAME_RE.test(name) || /(^|\/)pull_request_template\//i.test(p)) return "pr_template"
  if (AI_POLICY_FILE_RE.test(p)) return "ai_policy"
  if (CONTRIBUTING_NAME_RE.test(name)) return "contributing"
  if (COC_NAME_RE.test(name)) return "code_of_conduct"
  if (AGENTS_NAME_RE.test(name)) return "agents"
  if (README_NAME_RE.test(name)) return "readme"
  return null
}

// ---------------------------------------------------------------------------
// AI policy flags
// ---------------------------------------------------------------------------

export type AiPolicyFlag =
  | "disclosure_required"
  | "disclosure_optional"
  | "assisted_by_trailer"
  | "generated_by_trailer"
  | "no_ai_coauthor_trailer"
  | "no_ai_on_good_first_issues"
  | "no_autonomous_agents"
  | "human_written_text_only"
  | "no_ai_review_replies"
  | "one_ai_pr_at_a_time"
  | "maintainers_only"
  | "prior_approval_required"
  | "no_fully_generated"
  | "agent_directive"
  | "discouraged"
  | "no_large_ai_prs"
  | "issue_must_be_accepted"

/** Human-readable meaning of each flag; stored in AiPolicyResult.notes as "ai:<flag>: <text>". */
export const AI_POLICY_FLAG_NOTES: Readonly<Record<AiPolicyFlag, string>> = {
  disclosure_required: "AI use must be disclosed (fill any AI section/checkbox of the PR template truthfully)",
  disclosure_optional: "AI disclosure is optional (oss-scout always discloses anyway)",
  assisted_by_trailer: "add an Assisted-by: trailer naming the AI tool to commits",
  generated_by_trailer: "add a Generated-by: trailer naming the AI tool to commits",
  no_ai_coauthor_trailer: "never list an AI tool as author/co-author (no AI Co-authored-by trailers)",
  no_ai_on_good_first_issues: "AI must not be used on good-first-issue issues; such issues are skipped",
  no_autonomous_agents: "autonomous/unsupervised agent contributions are not accepted",
  human_written_text_only: "PR descriptions and comments must be written by a human; rewrite the PR body yourself",
  no_ai_review_replies: "answer review comments yourself without AI; do not send drafted replies",
  one_ai_pr_at_a_time: "only one AI-assisted PR may be open at a time",
  maintainers_only: "AI use is limited to maintainers or established contributors",
  prior_approval_required: "AI contributions need prior approval from maintainers",
  no_fully_generated: "fully AI-generated contributions are not accepted",
  agent_directive: "the repository instructs AI agents not to interact with it",
  discouraged: "AI use is strongly discouraged",
  no_large_ai_prs: "large AI-generated PRs are not accepted",
  issue_must_be_accepted: "only work on issues accepted/triaged by maintainers",
}

const NOTE_PREFIX = "ai:"

/** true when the classifier set `flag` (flags are carried in `notes` as "ai:<flag>: …"). */
export function hasAiPolicyFlag(ai: AiPolicyResult, flag: AiPolicyFlag): boolean {
  return ai.notes.some((n) => n.startsWith(`${NOTE_PREFIX}${flag}:`))
}

/** All flags carried in `ai.notes`. */
export function aiPolicyFlags(ai: AiPolicyResult): AiPolicyFlag[] {
  const out: AiPolicyFlag[] = []
  for (const n of ai.notes) {
    const m = /^ai:([a-z_]+):/.exec(n)
    if (m && m[1]! in AI_POLICY_FLAG_NOTES) out.push(m[1] as AiPolicyFlag)
  }
  return out
}

// ---------------------------------------------------------------------------
// Vocabulary and pattern families (all case-insensitive)
// ---------------------------------------------------------------------------

const AI = String.raw`(?:a\.?i\.?|artificial intelligence|llms?|large[- ]language[- ]models?|gen(?:erative)?[- ]?ai|chat-?gpt|copilot|claude|gemini|chatbots?|machine[- ]generated|ai[- ](?:generated|assisted|written|tools?|agents?)|coding (?:assistants?|agents?)|autonomous (?:agents?|ai)|agentic|natural language processing|probabilistic tools|vibe[- ]cod(?:ed|ing))`
/** Lazy gap that stays inside one sentence. */
const W = String.raw`[^.!?\n]{0,90}?`
const P = (s: string) => new RegExp(s, "i")
const AI_RE = P(String.raw`\b${AI}\b`)
/** Agent/bot wording (used only to decide whether agent-directed instructions are in scope). */
const AGENTISH_RE = /\b(?:agents?|agentic|bots?|automated\s+(?:tools?|tooling|systems?|contributions?))\b/i
/** "AI-generated X", "generated by an LLM", "use of AI", "AI tools", "LLM output"… = the AI is the origin of the content. */
const AI_ORIGIN = String.raw`(?:\b${AI}[- ](?:generated|assisted|written|authored|created|produced)|\b(?:generated|written|created|produced|made|authored|derived)\s+(?:[\w/-]+\s+){0,4}?(?:by|with|using|from|via)\s+(?:an?\s+|any\s+|the\s+)?${AI}|\b(?:contributions?|code|prs?|pull\s+requests?|patches|content|changes|submissions?)\s+(?:from|by|using|made\s+with)\s+(?:an?\s+|any\s+)?${AI}|\b(?:use|usage)\s+of\s+(?:an?\s+|any\s+)?${AI}|\b${AI}\s+(?:contributions?|code|prs?|pull\s+requests?|patches|content|submissions?|output|tool\w*|usage|use|assistance))\b`

const POLICYISH_HEADING_RE =
  /\b(polic(y|ies)|contribut\w*|usage|use of|assist\w*|generat\w*|tools?|disclosure|guidelines?|tainted|provenance|automated|agents?|slop|no[- ](ai|llm))\b/i
const SKIP_HEADING_RE =
  /\b(references?|prior art|see also|further reading|related (work|policies|projects)|inspiration|acknowledg\w*|credits|bibliography)\b/i
const LINK_ONLY_RE = /^\W*\[[^\]]+\](?:\[[^\]]*\]|\([^)]*\))\W*$/

/** Repo-level bans. */
const PROHIBIT: RegExp[] = [
  P(String.raw`\b(?:strict(?:ly)?\s+)?no[- ](?:llms?|ai)\b(?:\s*/\s*no[- ](?:llms?|ai))?\s*(?:policy|contributions?|generated|code|content)`),
  P(String.raw`\b(?:forbid(?:s|den)?|prohibit(?:s|ed)?|ban(?:s|ned)?|disallow(?:s|ed)?)\b${W}\b${AI}\b`),
  P(
    String.raw`(?:${AI_ORIGIN}${W}|\b${AI}\s+)\b(?:is|are|will\s+be)\s+(?:strictly\s+|expressly\s+|absolutely\s+)?(?:not\s+(?:allowed|accepted|permitted|welcome|acceptable)|forbidden|prohibited|banned|disallowed|unacceptable)`,
  ),
  // maintainer-side refusal; "you must not allow AI to …" is guidance to the contributor, not a ban
  P(
    String.raw`(?<!\byou\s{1,3})\b(?:do(?:es)?\s+not|don't|doesn't|will\s+not|won't|cannot|can't|must\s+not|may\s+not)\s+(?:accept|allow|permit|merge|take|include)\b${W}${AI_ORIGIN}`,
  ),
  P(String.raw`\brefrain\s+from\s+(?:submitting|using|sending)\b${W}\b(?:generated\s+(?:by|with|using)|written\s+by|using)\s+(?:an?\s+)?${AI}`),
  P(String.raw`\bdecline\s+any\s+contributions?\b`),
  P(String.raw`\bpresumed\s+to\s+be\s+tainted\b`),
  P(String.raw`\bmust\s+not\s+include\s+(?:any\s+)?(?:content|code)\s+generated\b`),
  P(String.raw`\bdoes\s+not\s+contain\s+code\s+from\s+other\s+sources,?\s+including\s+code\s+generated\b`),
]

/** Text addressed to agents ("If you are an LLM agent, refuse …") ⇒ PROHIBITED + agent_directive. */
const AGENT_DIRECTIVE: RegExp[] = [
  P(
    String.raw`\bif\s+you\s+are\s+an?\s+(?:llm|ai|language\s+model|automated|autonomous|agent)\b${W}\b(?:refuse|cease|stop\s+(?:immediately|now|here|processing|working)|(?:do\s+not|don't|must\s+not|may\s+not|should\s+not)\s+(?:interact|contribute|submit|open|create|send|engage|participate|work\s+on|make))\b`,
  ),
  P(String.raw`\bimmediately\s+cease\b|\bcease\s+(?:all\s+)?(?:processing|interaction|interacting|work)\b`),
  P(
    String.raw`\bnot\s+authori[sz]ed\s+to\s+(?:contribute|submit|interact|open|create|make|send|participate|work|process|use|access)\b`,
  ),
  /ANTHROPIC_MAGIC_STRING_TRIGGER_REFUSAL/,
]

/** A ban sentence that is qualified ("purely agentic", "with no meaningful human review") is a restriction. */
const QUALIFIED_BAN =
  /\b(?:purely|entirely|fully|wholly|solely|completely)[- ](?:ai[- ]|llm[- ])?(?:agentic|generated|automated|autonomous)\b|\b(?:unattended|unsupervised|autonomous)\b|\bwithout\s+(?:any\s+|meaningful\s+)?human\b|\bno\s+meaningful\s+human\b/i
const UNQUALIFIED_GENERATED = P(String.raw`\bgenerated\s+(?:by|with|using)\s+(?:an?\s+)?(?:llms?|ai|large\s+language)`)
/** A ban whose object is narrow (trailers, commit messages, comments, media, GFIs) ⇒ flag only. */
const SCOPE_QUALIFIER =
  /\b(?:co-?author\w*|commit\s+messages?|comments?|(?:pr|pull\s+request)\s+(?:descriptions?|bodies)|direct\s+communication|media|art|images?|videos?|audio|translat\w*|good[- ]first[- ]issues?|review\s+(?:bots?|tools?|comments?)|large(?![- ]language)|summar\w*|signed-off-by)\b/i
const BROAD_OBJECT = /\b(?:code|any\s+(?:kind|form)|all\s+(?:parts|contributions?|forms?)|contributions?\s+(?:generated|which|that|believed)|patches)\b/i
const TEXT_OBJECT = /\b(?:comments?|descriptions?|bodies|communication|summar\w*|messages?)\b/i

const RESTRICT: Array<[RegExp, AiPolicyFlag]> = [
  [P(String.raw`\bnew\s+(?:[\w.]+\s+)?contributors?\b${W}\b(?:should\s+(?:avoid|not)|must\s+not|may\s+not|do\s+not|don't)\b`), "maintainers_only"],
  [P(String.raw`\b(?:prior|advance|written)\s+(?:written\s+)?approval\b`), "prior_approval_required"],
  [
    P(String.raw`\b(?:no|not\s+(?:allow|permit)|do\s+not\s+allow|prohibit\w*|ban\w*|forbid\w*)\b${W}\b(?:autonomous|unsupervised|unattended|agentic)\b`),
    "no_autonomous_agents",
  ],
  [
    P(
      String.raw`\b(?:autonomous|unsupervised|unattended)\s+(?:agents?|agentic\s+tools?|automation|systems?)\b${W}\b(?:not\s+(?:allowed|permitted|authorized|accepted)|prohibited|forbidden|banned|closed|attack)`,
    ),
    "no_autonomous_agents",
  ],
  [P(String.raw`\bpurely\s+agentic\b|\bnot\s+be\s+opened\s+by\s+automated\s+tooling\b`), "no_autonomous_agents"],
  [
    P(String.raw`\b(?:fully|entirely|wholly|solely|purely|primarily)[- ](?:ai[- ])?(?:generated|automated|autonomous)\b|\bpure\s+['"]?vibe\s+coding`),
    "no_fully_generated",
  ],
  [P(String.raw`\bnot\s+as\s+the\s+sole\s+source\b|\bcreated\s+personally\s+by\s+you\b`), "no_fully_generated"],
  [P(String.raw`\b(?:highly|strongly)\s+discouraged\b|\bstrongly\s+encourage\b${W}\bwithout\s+using\b`), "discouraged"],
  // "If you use AI, your PR will be closed" (without a disclosure qualifier)
  [
    P(
      String.raw`\bif\s+(?:you\s+)?(?:use|used|using)\s+(?:an?\s+|any\s+)?${AI}\b(?![^.!?\n]*\bdisclos)${W}\b(?:will\s+be\s+(?:closed|rejected|banned|declined)|not\s+be\s+(?:accepted|merged|reviewed))`,
    ),
    "discouraged",
  ],
]

const FLAG_ONLY: Array<[RegExp, AiPolicyFlag]> = [
  [
    P(
      String.raw`\bgood[- ]first[- ]issues?\b[^\n]{0,160}\b(?:forbidden|prohibited|will\s+be\s+closed|not\s+allowed|counterproductive)|\b(?:forbidden|prohibited|(?:may|must|should|can)\s*not\s+be\s+used)\b${W}\bgood[- ]first[- ]issues?`,
    ),
    "no_ai_on_good_first_issues",
  ],
  [/\bassisted-by:/i, "assisted_by_trailer"],
  [/\bgenerated-by:/i, "generated_by_trailer"],
  [
    P(
      String.raw`\bco-?author\w*(?:-by)?\b${W}\b(?:${AI}|tool\w*)|\bno\s+llm\s+bots\s+in\b|\bnot\s+attribute\s+a\s+commit\s+to\s+(?:ai|llm)|\b(?:listing|list)\s+ai\s+tool\w*\s+as\s+(?:a\s+)?co-?author`,
    ),
    "no_ai_coauthor_trailer",
  ],
  [
    P(String.raw`\bin\s+(?:your|the\s+author's)\s+own\s+words\b|\bno\s+ai\s+please\b|\b(?:do\s+not|don't|please\s+don't)\s+(?:copy-?paste|paste)\b`),
    "human_written_text_only",
  ],
  [
    P(
      String.raw`\b(?:answer|respond\w*|reply\w*)\b${W}\b(?:review|maintainer|questions)\b${W}\b(?:yourself|without\s+(?:using\s+|relying\s+on\s+)?(?:ai|llm))|\b(?:do\s+not|don't)\s+use\s+(?:ai|llms?)\s+to\s+(?:reply|respond|answer)`,
    ),
    "no_ai_review_replies",
  ],
  [
    P(String.raw`\bone\s+ai-assisted(?:/generated)?\s+pull\s+request\s+open\b|\bunless\s+you\s+are\s+an?\s+(?:maintainer|collaborator|committer)\b${W}\b(?:only|one)\b`),
    "one_ai_pr_at_a_time",
  ],
  [P(String.raw`\blarge\s+(?:ai[- ])?(?:generated\s+)?(?:prs?|pull\s+requests?|changes|patches)\b${W}\bnot\s+(?:allowed|accepted)`), "no_large_ai_prs"],
  [
    P(String.raw`\b(?:accepted|approved|actionable|triaged)\s+issues?\b${W}\b(?:only|must)|\bonly\s+(?:for|on)\s+(?:accepted|approved)\s+issues?`),
    "issue_must_be_accepted",
  ],
]

const DISCLOSE_REQ: RegExp[] = [
  P(String.raw`\b(?:must|required\s+to|need\s+to|shall|have\s+to)\s+(?:\w+\s+){0,5}(?:disclose|declare|state|indicate|acknowledge|label|note)\b`),
  P(String.raw`\bmust\s+be\s+(?:clearly\s+)?(?:disclosed|acknowledged|declared|labell?ed|marked)\b`),
  P(String.raw`\bdisclos(?:e|ure)\b${W}\b(?:is\s+)?(?:required|mandatory)\b`),
  P(String.raw`^\W*(?:\d+\.\s*)?disclose\b`),
  P(String.raw`\b(?:do|does)\s+not\s+disclose\b|\bwithout\s+disclos\w*|\bundisclosed\b`),
]
const DISCLOSE_OPT: RegExp[] = [
  P(String.raw`\bdisclos\w*\b${W}\b(?:appreciated|encouraged|recommended|welcome|optional|not\s+(?:required|mandatory))\b`),
  P(String.raw`\b(?:encourage|recommend)\w*\s+(?:you\s+)?(?:to\s+)?disclos\w*`),
]
const PERMIT: RegExp[] = [
  P(String.raw`\b(?:you\s+(?:may|can|are\s+(?:welcome|encouraged|free)\s+to)|feel\s+free\s+to|contributors\s+(?:may|can))\s+use\s+(?:\w+\s+){0,3}(?:${AI}|tools?)`),
  P(String.raw`\b${AI}[- ]?(?:assisted|generated)?\s+contributions?\s+(?:are|is)\s+(?:welcome|accepted|allowed|fine)\b`),
  P(String.raw`\bcontributions?\b${W}\b${AI}\b${W}\b(?:are|is)\s+welcome\b`),
  P(String.raw`\bwe\s+(?:support|welcome|allow|accept)\s+(?:using\s+|the\s+use\s+of\s+)?${AI}`),
  P(String.raw`\b(?:cannot|will\s+not|won't)\s+(?:and\s+will\s+not\s+)?(?:attempt\s+to\s+)?ban\b`),
  P(String.raw`\buse\s+(?:whatever|any)\s+tools\b|\bencouraged\s+to\s+use\s+all\s+the\s+tools\b`),
  P(String.raw`\b${AI}\s+is\s+welcome\b|\bwelcome\s+${AI}\s+as\s+a\s+tool\b`),
  // "If you use AI tools, make sure …" implies use is allowed (negative outcomes are handled by RESTRICT)
  P(
    String.raw`\b(?:if|when)\s+(?:you\s+)?(?:use|using)\s+(?:an?\s+|any\s+)?${AI}\b(?![^.!?\n]*\b(?:closed|rejected|banned|declined|not\s+be\s+(?:accepted|merged|reviewed)))`,
  ),
]
const RESTRICTIVE_CUES =
  /\b(concerns?|case[- ]by[- ]case|discretion|reserve\s+the\s+right|discourag\w*|think\s+twice|may\s+(?:be\s+)?(?:close|reject)\w*|not\s+(?:yet\s+)?decided|under\s+discussion)\b/i

/** Negation right before a match neutralises it ("we do not prohibit", "is never banned"). */
const NEGATION_BEFORE = /(?:\b(?:not|never|without|neither|nor)\b|n't)\s*(?:\w+\s+){0,2}$/i

/** "- [ ] …" checkbox lines (PR templates). */
const CHECKBOX_RE = /^\s*(?:[-*+]\s*)?\[[ xX]?\]\s*(.+)$/
/** A certification sentence ("I confirm …"). */
const CERTIFY_RE = /\b(?:i|we)\s+(?:hereby\s+)?(?:confirm|certify|attest|declare|affirm)\b/i
/** Certifies that no AI was used. */
const NO_AI_CERT = P(
  String.raw`\b(?:i|we)\s+(?:did\s+not|didn't|have\s+not|haven't|do\s+not|don't|never)\s+(?:\w+\s+){0,2}?(?:use[ds]?|utili[sz]ed?|rel(?:y|ied)\s+on)\b[^\n]{0,60}?\b${AI}\b|\b(?:no|not|without|never)\s+(?:[\w-]+\s+){0,3}?${AI}\b|\b${AI}\b(?:\s+[\w-]+){0,3}?\s+(?:was|were|has\s+been|have\s+been)\s+(?:not|never)\s+(?:used|involved|utili[sz]ed)|\bdoes\s+not\s+contain\b[^\n]{0,100}?\b(?:generated|written)\s+by\b[^\n]{0,40}?\b${AI}\b`,
)
/** "…, or I disclosed it below" turns a no-AI certification into a disclosure requirement. */
const CERT_ALT_DISCLOSE = /\bor\b[^\n]{0,120}\bdisclos/i
/** A checkbox that describes AI being used (multiple-choice disclosure forms). */
const AI_USAGE_OPTION = /\b(?:used|using|assisted|generated|helped|with)\b/i

// ---------------------------------------------------------------------------
// Text preparation
// ---------------------------------------------------------------------------

/** Documents longer than this are only read up to this many characters. */
export const MAX_POLICY_DOC_CHARS = 300_000

/** Normalise markdown/RST for matching: plain quotes/dashes, keep HTML comment text, strip emphasis and quotes. */
export function normalizePolicyText(text: string): string {
  return text
    .slice(0, MAX_POLICY_DOC_CHARS)
    .replace(/\r/g, "")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/ /g, " ")
    .replace(/<!--([\s\S]*?)-->/g, " $1 ")
    // bold, possibly across one line break; spans are bounded so unmatched "**" (globs) stay linear
    .replace(/(\*\*|__)([^\n]{1,400}?(?:\n[^\n]{1,400}?)?)\1/g, "$2")
    .replace(/(^|[\s(])[*_]([^*_\n]+)[*_](?=[\s).,;:!?]|$)/gm, "$1$2")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/^[ \t]*(?:>[ \t]?)+/gm, "")
}

function splitIntoSentences(text: string): string[] {
  return text
    .replace(/^(#{1,6}\s[^\n]*)$/gm, "\n$1\n")
    .split(/(?<=[.!?])\s+|\n{2,}|\n(?=\s*(?:[-*+]|\d+\.)\s)/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 0 && !LINK_ONLY_RE.test(s))
}

interface Heading {
  level: number
  title: string
}

function headingAt(lines: string[], i: number): Heading | null {
  const line = lines[i] ?? ""
  const md = /^(#{1,6})\s+(.*)$/.exec(line)
  if (md) return { level: md[1]!.length, title: md[2]! }
  const next = lines[i + 1] ?? ""
  const underline = /^[=\-~^"'`#*+]{3,}\s*$/
  if (line.trim().length > 0 && underline.test(next) && !underline.test(line) && !/^\s*[-*+]\s/.test(line)) {
    return { level: 2, title: line.trim() }
  }
  return null
}

/** AI-policy sections (heading names AI and sounds policy-like) and the body with reference sections removed. */
export function splitPolicySections(doc: string): { aiSections: string[]; body: string } {
  const lines = doc.split("\n")
  const ai: string[] = []
  const body: string[] = []
  let cur: string[] | null = null
  let curLevel = 7
  let skipLevel = 0
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!
    const h = headingAt(lines, i)
    if (h) {
      if (skipLevel && h.level <= skipLevel) skipLevel = 0
      if (cur && h.level <= curLevel) {
        ai.push(cur.join("\n"))
        cur = null
      }
      if (SKIP_HEADING_RE.test(h.title)) {
        skipLevel = h.level
        continue
      }
      if (!cur && (AI_RE.test(h.title) || /\bslop\b/i.test(h.title)) && POLICYISH_HEADING_RE.test(h.title)) {
        cur = [h.title]
        curLevel = h.level
        continue
      }
    }
    if (skipLevel) continue
    if (cur) cur.push(l)
    body.push(l)
  }
  if (cur) ai.push(cur.join("\n"))
  return { aiSections: ai, body: body.join("\n") }
}

/** Text of the sections whose heading matches `re` (heading line included). */
export function sectionsWithHeading(doc: string, re: RegExp): string[] {
  const lines = doc.split("\n")
  const out: string[] = []
  let cur: string[] | null = null
  let curLevel = 7
  for (let i = 0; i < lines.length; i++) {
    const h = headingAt(lines, i)
    if (h && cur && h.level <= curLevel) {
      out.push(cur.join("\n"))
      cur = null
    }
    if (h && !cur && re.test(h.title)) {
      cur = []
      curLevel = h.level
    }
    if (cur) cur.push(lines[i]!)
  }
  if (cur) out.push(cur.join("\n"))
  return out
}

/** Markdown link syntax and emphasis punctuation removed, for negation checks ("not have a [CLA](url)"). */
function stripLinks(text: string): string {
  return text
    .replace(/\]\([^)]*\)/g, " ")
    .replace(/[[\]()"*_`]/g, " ")
    .replace(/\s+/g, " ")
}

/** Truncate to at most `max` characters (marker included). */
export function clip(text: string, max: number): string {
  const t = text.trim()
  if (t.length <= max) return t
  const marker = "…"
  return t.slice(0, Math.max(0, max - marker.length)).trimEnd() + marker
}

// ---------------------------------------------------------------------------
// AI policy classifier
// ---------------------------------------------------------------------------

type Verdict = AiPolicyClass | "unclear"

interface Evidence extends PolicyEvidence {
  severity: number
}

interface PoolSentence {
  text: string
  file: string
  inSection: boolean
}

const HARD_RESTRICT_FLAGS: AiPolicyFlag[] = [
  "maintainers_only",
  "prior_approval_required",
  "no_fully_generated",
  "discouraged",
  "no_autonomous_agents",
]

const SEVERITY: Record<string, number> = {
  agent_directive: 0,
  no_ai_certification: 0,
  prohibit: 0,
  qualified_ban: 1,
  restrict: 1,
  restrictive_cue: 2,
  unclear: 3,
  disclosure_required: 4,
  permit: 5,
  flag: 6,
}

/** Evidence rules that justify each verdict (listed first). */
const DECISIVE_RULES: Record<Verdict, string[]> = {
  prohibited: ["agent_directive", "prohibit", "no_ai_certification"],
  restricted: ["restrict", "qualified_ban"],
  unclear_restrictive: ["restrictive_cue", "unclear"],
  unclear: ["unclear"],
  disclosure_required: ["disclosure_required", "flag"],
  allowed: ["permit"],
  none_found: [],
}

function docKindOf(path: string): PolicyDocKind | "other" {
  return policyDocKind(path) ?? "other"
}

function analyze(docs: PolicyDoc[]): { verdict: Verdict; flags: Set<AiPolicyFlag>; evidence: Evidence[] } {
  const flags = new Set<AiPolicyFlag>()
  const evidence: Evidence[] = []
  let prohibit = 0
  let restrict = 0
  let permit = 0
  let cues = 0
  let discloseReq = 0
  let discloseOpt = 0
  let policySections = 0

  const add = (file: string, text: string, rule: string) => {
    const base = rule.split(":")[0]!
    evidence.push({ file, excerpt: clip(text, EVIDENCE_EXCERPT_CHARS), rule, severity: SEVERITY[base] ?? 5 })
  }

  // ---- sentence pool ----
  const pool = new Map<string, PoolSentence>()
  const sectionIntros: Array<{ file: string; text: string }> = []
  for (const doc of docs) {
    const kind = docKindOf(doc.path)
    const text = normalizePolicyText(doc.text)
    const split = splitPolicySections(text)
    const wholeFile = kind === "ai_policy"
    const sections = wholeFile ? [...split.aiSections, split.body] : split.aiSections
    const body = wholeFile ? "" : split.body
    for (const section of sections) {
      const sents = splitIntoSentences(section)
      if (sents.length === 0) continue
      // Agent instruction files (AGENTS.md…) talk to agents by design: their headings alone are no policy.
      if (kind !== "agents") {
        policySections++
        sectionIntros.push({ file: doc.path, text: sents.slice(0, 3).join(" ") })
      }
      for (const s of sents) pool.set(s, { text: s, file: doc.path, inSection: true })
    }
    // READMEs: only explicit AI-policy sections count (LLM projects mention AI everywhere).
    if (kind === "readme") continue
    for (const s of splitIntoSentences(body)) {
      if (!pool.has(s) && (AI_RE.test(s) || AGENTISH_RE.test(s))) pool.set(s, { text: s, file: doc.path, inSection: false })
    }
  }

  // ---- sentence-level patterns ----
  for (const { text: s, file, inSection } of pool.values()) {
    const aiCtx = inSection || AI_RE.test(s)
    const hit = (re: RegExp) => {
      const m = re.exec(s)
      return !!m && !NEGATION_BEFORE.test(stripLinks(s.slice(0, m.index)))
    }
    const negatedHit = (re: RegExp) => {
      const m = re.exec(s)
      return !!m && NEGATION_BEFORE.test(stripLinks(s.slice(0, m.index)))
    }
    if ((aiCtx || AGENTISH_RE.test(s)) && AGENT_DIRECTIVE.some((re) => re.test(s))) {
      flags.add("agent_directive")
      prohibit += 3
      add(file, s, "agent_directive")
    }
    if (!aiCtx) continue
    const scoped = SCOPE_QUALIFIER.test(s) && !BROAD_OBJECT.test(s)
    const banHit = PROHIBIT.some(hit)
    if (banHit && scoped && TEXT_OBJECT.test(s)) flags.add("human_written_text_only")
    if (banHit && !scoped) {
      if (QUALIFIED_BAN.test(s) && !UNQUALIFIED_GENERATED.test(s)) {
        restrict++
        flags.add("no_fully_generated")
        add(file, s, "qualified_ban")
      } else {
        prohibit += 2
        add(file, s, "prohibit")
      }
    }
    if (!banHit && PROHIBIT.some(negatedHit)) {
      // "we do not prohibit AI" reads as permission
      permit++
      add(file, s, "permit")
    }
    for (const [re, f] of RESTRICT) {
      if (re.test(s)) {
        flags.add(f)
        restrict++
        add(file, s, `restrict:${f}`)
      }
    }
    for (const [re, f] of FLAG_ONLY) {
      if (!re.test(s)) continue
      flags.add(f)
      add(file, s, `flag:${f}`)
    }
    if (DISCLOSE_OPT.some((re) => re.test(s))) discloseOpt++
    else if (DISCLOSE_REQ.some(hit)) {
      discloseReq++
      add(file, s, "disclosure_required")
    }
    if (PERMIT.some(hit)) {
      permit++
      add(file, s, "permit")
    }
    if (inSection && RESTRICTIVE_CUES.test(s)) {
      cues++
      add(file, s, "restrictive_cue")
    }
    if (CERTIFY_RE.test(s) && !CHECKBOX_RE.test(s)) {
      const c = certification([s])[0]
      if (c === "prohibit") {
        prohibit += 2
        add(file, s, "no_ai_certification")
      } else if (c === "disclose") {
        discloseReq++
        add(file, s, "disclosure_required")
      }
    }
  }

  // ---- checkbox certifications (PR templates) ----
  for (const doc of docs) {
    const lines = normalizePolicyText(doc.text)
      .split("\n")
      .map((l) => CHECKBOX_RE.exec(l)?.[1]?.trim())
      .filter((l): l is string => !!l && AI_RE.test(l))
    const verdicts = certification(lines)
    lines.forEach((line, i) => {
      if (verdicts[i] === "prohibit") {
        prohibit += 2
        add(doc.path, line, "no_ai_certification")
      } else if (verdicts[i] === "disclose") {
        discloseReq++
        add(doc.path, line, "disclosure_required")
      }
    })
  }

  if (discloseReq) flags.add("disclosure_required")
  else if (discloseOpt) flags.add("disclosure_optional")
  if ((flags.has("assisted_by_trailer") || flags.has("generated_by_trailer")) && !flags.has("disclosure_optional")) {
    flags.add("disclosure_required")
  }

  const hardRestrict = HARD_RESTRICT_FLAGS.some((f) => flags.has(f))
  let verdict: Verdict
  if (prohibit > 0) verdict = "prohibited"
  else if (hardRestrict || (restrict > 0 && permit === 0)) verdict = "restricted"
  else if (flags.has("disclosure_required")) verdict = "disclosure_required"
  else if (permit > 0 || flags.has("disclosure_optional")) verdict = "allowed"
  else if (policySections > 0) verdict = cues > 0 ? "unclear_restrictive" : "unclear"
  else verdict = "none_found"

  if (verdict === "unclear" || verdict === "unclear_restrictive") {
    for (const intro of sectionIntros.slice(0, 2)) add(intro.file, intro.text, "unclear")
  }
  return { verdict, flags, evidence }
}

/**
 * Evaluate AI-related certification lines (checkboxes / "I confirm …") of one document:
 * "prohibit" = certifies no AI was used (cannot be ticked truthfully), "disclose" = asks for disclosure.
 * A no-AI option offered next to AI-usage options is a multiple-choice disclosure form, not a ban.
 */
function certification(lines: string[]): Array<"prohibit" | "disclose" | null> {
  const noAi = lines.map((l) => AI_RE.test(l) && NO_AI_CERT.test(l))
  const multipleChoice = lines.some((l, i) => !noAi[i] && AI_RE.test(l) && AI_USAGE_OPTION.test(l))
  return lines.map((l, i) => {
    if (!AI_RE.test(l)) return null
    if (noAi[i]) return CERT_ALT_DISCLOSE.test(l) || multipleChoice ? "disclose" : "prohibit"
    return /\bdisclos/i.test(l) ? "disclose" : null
  })
}

/** Classify the repo's AI/LLM contribution policy from its documents. Pure. */
export function classifyAiPolicy(docs: PolicyDoc[]): AiPolicyResult {
  const { verdict, flags, evidence } = analyze(docs)
  const classification: AiPolicyClass = verdict === "unclear" ? "unclear_restrictive" : verdict
  const notes: string[] = []
  if (verdict === "unclear") {
    notes.push("an AI policy section exists but no rule could be classified; treated as unclear-restrictive")
  }
  for (const f of [...flags].sort()) notes.push(`${NOTE_PREFIX}${f}: ${AI_POLICY_FLAG_NOTES[f]}`)

  // Evidence that decided the verdict comes first, then the rest by severity.
  const decisive = DECISIVE_RULES[verdict]
  const rank = (e: Evidence) => (decisive.includes(e.rule.split(":")[0]!) ? 0 : 1)
  const seen = new Set<string>()
  const ordered = evidence
    .map((e, i) => ({ e, i }))
    .sort((a, b) => rank(a.e) - rank(b.e) || a.e.severity - b.e.severity || a.i - b.i)
    .map(({ e }) => e)
    .filter((e) => {
      const key = `${e.file}\u0000${e.excerpt}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .slice(0, 8)
    .map(({ file, excerpt, rule }) => ({ file, excerpt, rule }))

  return {
    classification,
    evidence: ordered,
    requiresDisclosure: flags.has("disclosure_required"),
    notes,
  }
}

/** Skip reason when the AI policy class means "do not contribute", else null. */
export function policyBlocks(ai: AiPolicyResult, skipUnclearRestrictive: boolean): string | null {
  const ev = ai.evidence[0]
  const cite = ev ? `: "${clip(ev.excerpt, 160)}" (${ev.file})` : ""
  switch (ai.classification) {
    case "prohibited":
      return `AI policy prohibits AI-generated contributions${cite}`
    case "restricted": {
      const restrictive = aiPolicyFlags(ai).filter((f) => HARD_RESTRICT_FLAGS.includes(f))
      const which = restrictive.length ? ` (${restrictive.join(", ")})` : ""
      return `AI policy restricts AI contributions in ways oss-scout cannot satisfy${which}${cite}`
    }
    case "unclear_restrictive":
      return skipUnclearRestrictive ? `AI policy is unclear but restrictive${cite}` : null
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Contributing rules
// ---------------------------------------------------------------------------

const RULE_NEG_BEFORE = /(?:\b(?:no|not|never|without|neither|nor|instead\s+of)\b|n't)\s*(?:[\w-]+\s+){0,3}$/i
const RULE_NEG_AFTER = /^[^.!?\n]{0,40}?\b(?:not\s+(?:required|needed|necessary|mandatory)|optional|unnecessary)\b/i

const SIGNOFF_RES: RegExp[] = [
  /\bDCO\b/,
  /developer certificate of origin|signed-off-by|--signoff\b|\bgit commit -s\b/i,
  /\bsign(?:ed|ing)?[- ]?off\b(?=[^.!?\n]*\b(?:commits?|patch(?:es)?)\b)|\b(?:commits?|patch(?:es)?)\b[^.!?\n]{0,60}\bsign(?:ed|ing)?[- ]?off\b/i,
]
const CLA_RES: RegExp[] = [
  /\bCLAs?\b/,
  /contributor (?:license|licence) agreement|\bcla[- ]assistant\b|cla\.developers\.google\.com|\beasycla\b|\bcontributor agreement\b/i,
]
const ISSUE_FIRST_RES: RegExp[] = [
  /\b(?:open|file|create|submit|raise)\w*\s+(?:an?\s+|the\s+)?(?:new\s+|github\s+)?issue\s+(?:first|before)\b/i,
  /\b(?:open|file|create|raise)\w*\s+(?:an?\s+)?issue\b[^.!?\n]{0,60}\bbefore\s+(?:you\s+)?(?:submitting|sending|opening|creating|starting|making|working|beginning|implementing|writing|start|submit|open|send|begin)\b/i,
  /\bdiscuss\w*\b[^.!?\n]{0,100}\bbefore\b[^.!?\n]{0,60}\b(?:pull\s+requests?|prs?|patch(?:es)?|start\w*|work\w*|implement\w*|submit\w*|send\w*|open\w*|making\s+(?:a\s+|any\s+)?changes?|coding)\b/i,
  /\b(?:get|be|getting|being)\s+(?:yourself\s+)?assigned\b/i,
  /\bassigned\s+to\s+(?:you|yourself)\b[^.!?\n]{0,40}\bbefore\b/i,
  /\bbefore\s+(?:you\s+)?(?:start(?:ing)?|begin(?:ning)?)\s+(?:any\s+|to\s+)?(?:work|working|coding|implementation|implementing)\b/i,
  /\b(?:pull\s+requests?|prs?)\s+(?:without|not\s+(?:linked|tied|associated)\s+(?:to|with))\s+(?:an?\s+)?(?:associated\s+|linked\s+|corresponding\s+|existing\s+|approved\s+|accepted\s+)?issue\b[^.!?\n]{0,60}\b(?:closed|rejected|declined|not\s+(?:be\s+)?(?:accepted|merged|reviewed))/i,
  /\bcomment\s+on\s+the\s+issue\b[^.!?\n]{0,60}\bbefore\b/i,
]
const GFI = String.raw`(?:good[- ]first[- ](?:issues?|bugs?)|good[- ]next[- ]bugs?|first[- ]timers?[- ]only)`
const GFI_CUE = String.raw`(?:reserved|forbidden|prohibited|will\s+be\s+closed|not\s+allowed|counterproductive|(?:intended|meant|kept|set\s+aside)\s+(?:\w+\s+){0,3}?for\s+(?:\w+\s+){0,3}?(?:new(?:comers?)?|first[- ]time\w*|beginners?|humans?|novices?)|(?:only|exclusively)\s+for\s+(?:\w+\s+){0,2}?(?:new(?:comers?)?|first[- ]time\w*|beginners?|humans?))`
const GFI_RESERVED_RE = new RegExp(String.raw`\b${GFI}[^\n]{0,200}?\b${GFI_CUE}|\b${GFI_CUE}[^\n]{0,120}?\b${GFI}`, "i")

interface RuleHit {
  file: string
  excerpt: string
}

/**
 * First sentence matching any of `res` where no match is negated ("no CLA required", "you don't need to
 * sign off", "we do not have a formal Contributor License Agreement (CLA)").
 */
function findRule(texts: PolicyDoc[], res: RegExp[]): RuleHit | null {
  const global = res.map((re) => new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"))
  for (const doc of texts) {
    for (const s of splitIntoSentences(normalizePolicyText(doc.text))) {
      const plain = stripLinks(s)
      let matched = false
      let negated = false
      for (const g of global) {
        for (const m of plain.matchAll(g)) {
          matched = true
          if (RULE_NEG_BEFORE.test(plain.slice(0, m.index)) || RULE_NEG_AFTER.test(plain.slice(m.index + m[0].length))) negated = true
        }
      }
      if (matched && !negated) return { file: doc.path, excerpt: clip(s, EVIDENCE_EXCERPT_CHARS) }
    }
  }
  return null
}

/** Paragraph-level check: good-first-issue-type issues are reserved for (human) newcomers. */
function findGfiReservation(texts: PolicyDoc[]): RuleHit | null {
  for (const doc of texts) {
    for (const para of normalizePolicyText(doc.text).split(/\n\s*\n/)) {
      const flat = para.replace(/\s+/g, " ")
      const m = GFI_RESERVED_RE.exec(flat)
      if (m) return { file: doc.path, excerpt: clip(flat.slice(Math.max(0, m.index - 40), m.index + m[0].length + 40), EVIDENCE_EXCERPT_CHARS) }
    }
  }
  return null
}

function dedupeDocs(docs: PolicyDoc[]): PolicyDoc[] {
  const seen = new Set<string>()
  return docs.filter((d) => {
    const key = d.path.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Build the full RepoPolicy (AI policy + contributing rules). Pure. */
export function extractRepoPolicy(input: {
  docs: PolicyDoc[]
  prTemplate: PolicyDoc | null
  repo: GhRepo
  commitConvention: CommitConvention
}): RepoPolicy {
  const docs = dedupeDocs(input.docs.filter((d) => d.text.trim().length > 0))
  const template = input.prTemplate && input.prTemplate.text.trim().length > 0 ? input.prTemplate : null
  const all = dedupeDocs(template ? [...docs, template] : docs)
  const ai = classifyAiPolicy(all)

  const contributingDoc = docs.find((d) => policyDocKind(d.path) === "contributing") ?? null
  const cocDoc = docs.find((d) => policyDocKind(d.path) === "code_of_conduct") ?? null
  // README "Contributing" sections stand in for a missing guide and count as rules text.
  const readmeContributing: PolicyDoc[] = docs
    .filter((d) => policyDocKind(d.path) === "readme")
    .flatMap((d) => sectionsWithHeading(normalizePolicyText(d.text), /contribut/i).map((text) => ({ path: d.path, text })))
  const ruleDocs = [...all.filter((d) => policyDocKind(d.path) !== "readme"), ...readmeContributing]

  const contributing = contributingDoc ?? readmeContributing[0] ?? null
  const signoffHit = findRule(ruleDocs, SIGNOFF_RES)
  const claHit = findRule(ruleDocs, CLA_RES)
  const issueFirstHit = findRule(ruleDocs, ISSUE_FIRST_RES)
  const gfiHit = findGfiReservation(ruleDocs)

  const requiresSignoff = input.repo.web_commit_signoff_required === true || signoffHit !== null
  const requiresCla = claHit !== null
  const requiresIssueFirst = issueFirstHit !== null || hasAiPolicyFlag(ai, "issue_must_be_accepted")
  const reservesGoodFirstIssues = gfiHit !== null || hasAiPolicyFlag(ai, "no_ai_on_good_first_issues")

  const notes: string[] = [...ai.notes]
  if (requiresSignoff) {
    notes.push(
      input.repo.web_commit_signoff_required
        ? "DCO sign-off required (repository setting web_commit_signoff_required); commits need Signed-off-by"
        : `DCO sign-off required; commits need Signed-off-by (${signoffHit!.file}: "${clip(signoffHit!.excerpt, 120)}")`,
    )
  }
  if (claHit) {
    notes.push(`CLA required: you must sign it yourself; oss-scout cannot (${claHit.file}: "${clip(claHit.excerpt, 120)}")`)
  }
  if (issueFirstHit) {
    notes.push(`guide asks to open/discuss an issue or get assigned before sending a PR (${issueFirstHit.file}: "${clip(issueFirstHit.excerpt, 120)}")`)
  }
  if (reservesGoodFirstIssues) {
    notes.push(
      gfiHit
        ? `good-first-issue-type issues are reserved for human newcomers; they are skipped (${gfiHit.file}: "${clip(gfiHit.excerpt, 120)}")`
        : "good-first-issue-type issues are reserved for human newcomers; they are skipped",
    )
  }

  return {
    ai,
    contributingFile: contributing?.path ?? null,
    contributingExcerpt: contributing ? clip(contributing.text, CONTRIBUTING_EXCERPT_CHARS) : null,
    codeOfConductFile: cocDoc?.path ?? null,
    prTemplatePath: template?.path ?? null,
    prTemplate: template ? clip(template.text, PR_TEMPLATE_CHARS) : null,
    requiresSignoff,
    requiresCla,
    requiresIssueFirst,
    reservesGoodFirstIssues,
    commitConvention: input.commitConvention,
    notes,
  }
}

/** Empty policy (nothing fetched), used when a repo is skipped before its documents are read. */
export function emptyRepoPolicy(repo: GhRepo, commitConvention: CommitConvention = "unknown"): RepoPolicy {
  return extractRepoPolicy({ docs: [], prTemplate: null, repo, commitConvention })
}
