/**
 * Mention highlighting (docs/plans/phase-4.md, "Mention rendering"). The pattern is the server's
 * (CONTRACTS B.5a rule 2): `@` not preceded by a word character or another `@`, then 3–32 of
 * `[a-z0-9_]`, case-insensitive. Like the server, only usernames of active users are mentions.
 */
export const MENTION_PATTERN = /(?<![\w@])@([a-z0-9_]{3,32})/gi;

/** The minimal mdast shape this plugin needs (mdast types aren't a direct dependency). */
interface MdastNode {
  type: string;
  value?: string;
  children?: MdastNode[];
  data?: { hName?: string; hProperties?: Record<string, string | string[]> };
}

export interface RemarkMentionsOptions {
  /** The signed-in user's username: mentions of it get `data-self="true"`. */
  selfUsername?: string;
  /**
   * Lowercased usernames of active users (from bootstrap `users`). Only these are highlighted;
   * without it nothing is.
   */
  usernames?: ReadonlySet<string>;
}

function mentionNode(text: string, self: boolean): MdastNode {
  return {
    type: 'mention',
    children: [{ type: 'text', value: text }],
    // mdast-util-to-hast turns an unknown node with `data.hName` into that element.
    data: {
      hName: 'span',
      hProperties: { className: ['mention'], dataTestid: 'mention', dataSelf: self ? 'true' : 'false' },
    },
  };
}

/** `value` split into text and mention nodes, or `null` if it mentions nobody. */
function splitMentions(
  value: string,
  selfUsername: string | undefined,
  usernames: ReadonlySet<string>,
): MdastNode[] | null {
  const nodes: MdastNode[] = [];
  let last = 0;
  for (const match of value.matchAll(MENTION_PATTERN)) {
    const [text, rawUsername = ''] = match;
    const username = rawUsername.toLowerCase();
    if (!usernames.has(username)) continue;
    if (match.index > last) nodes.push({ type: 'text', value: value.slice(last, match.index) });
    nodes.push(mentionNode(text, username === selfUsername));
    last = match.index + text.length;
  }
  if (nodes.length === 0) return null;
  if (last < value.length) nodes.push({ type: 'text', value: value.slice(last) });
  return nodes;
}

const NO_USERNAMES: ReadonlySet<string> = new Set();

/**
 * Remark plugin: splits `@username` of a known active user out of text nodes into
 * `span[data-testid="mention"]` elements (`data-self="true"` for the signed-in user). Only `text`
 * nodes are touched, so inline code and code blocks (whose content lives in `value`, not in text
 * children) are left as they are.
 */
export function remarkMentions(options: RemarkMentionsOptions = {}) {
  const selfUsername = options.selfUsername?.toLowerCase();
  const usernames = options.usernames ?? NO_USERNAMES;
  const walk = (node: MdastNode): void => {
    if (!node.children) return;
    node.children = node.children.flatMap((child) => {
      if (child.type === 'text' && child.value)
        return splitMentions(child.value, selfUsername, usernames) ?? [child];
      walk(child);
      return [child];
    });
  };
  return walk;
}
