import { useMemo } from 'react';
import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { remarkMentions } from './remarkMentions';

/**
 * Elements a message may render (docs/plans/phase-3.md, "Markdown"). Anything else — headings,
 * tables, hr — is unwrapped to its children (or dropped when it has none). Images and task-list
 * checkboxes never get this far: `remarkImagesAndTasksAsText` turns them into text first.
 * `span` only comes from the mention plugin (Markdown itself never produces one).
 */
export const ALLOWED_ELEMENTS = [
  'p',
  'strong',
  'em',
  'del',
  'code',
  'pre',
  'a',
  'ul',
  'ol',
  'li',
  'blockquote',
  'br',
  'span',
] as const;

/** The minimal mdast shape the plugins below need (mdast types aren't a direct dependency). */
interface MdastNode {
  type: string;
  value?: string;
  url?: string;
  alt?: string | null;
  title?: string | null;
  checked?: boolean | null;
  children?: MdastNode[];
}

/**
 * Remark plugin: every raw HTML node (block or inline) becomes a text node with the same value, so
 * typed HTML is shown literally — escaped by React — instead of being interpreted or dropped.
 */
export function remarkHtmlAsText() {
  const walk = (node: MdastNode): void => {
    if (node.type === 'html') node.type = 'text';
    node.children?.forEach(walk);
  };
  return walk;
}

const SAFE_IMAGE_LINK = /^https?:\/\//i;

/**
 * Remark plugin: messages never show images, but their alt text must not vanish with them.
 * `![alt](https://…)` becomes a link with the alt text (the URL when there is no alt text); any other
 * image (another scheme, a reference, or one inside a link, where a nested link isn't allowed)
 * becomes its alt text. A GFM task-list item (`- [x] done`) shows its state as ☑ / ☐ text
 * instead of a checkbox.
 */
export function remarkImagesAndTasksAsText() {
  const walk = (node: MdastNode, inLink: boolean): void => {
    if (node.type === 'image' || node.type === 'imageReference') {
      const alt = node.alt ?? '';
      const url = node.type === 'image' ? (node.url ?? '') : '';
      if (!inLink && SAFE_IMAGE_LINK.test(url)) {
        node.type = 'link';
        node.children = [{ type: 'text', value: alt || url }];
        node.title = null;
      } else {
        node.type = 'text';
        node.value = alt;
      }
      delete node.alt;
      return;
    }
    if (node.type === 'listItem' && typeof node.checked === 'boolean') {
      const box: MdastNode = { type: 'text', value: node.checked ? '☑ ' : '☐ ' };
      const first = node.children?.[0];
      if (first?.type === 'paragraph') (first.children ??= []).unshift(box);
      else (node.children ??= []).unshift({ type: 'paragraph', children: [box] });
      node.checked = null;
    }
    const childInLink = inLink || node.type === 'link' || node.type === 'linkReference';
    node.children?.forEach((child) => {
      walk(child, childInLink);
    });
  };
  return (tree: MdastNode) => {
    walk(tree, false);
  };
}

type Pluggable = NonNullable<Options['remarkPlugins']>[number];

const components: Components = {
  // `urlTransform` (the default one) blanks unsafe URLs such as `javascript:`; render those as text.
  a: ({ href, children }) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
};

export interface MarkdownProps {
  children: string;
  /** The signed-in user's username (its mentions get `data-self="true"`). */
  selfUsername?: string;
  /** Lowercased usernames of active users; only their `@username` is highlighted. */
  usernames?: ReadonlySet<string>;
}

/**
 * Safe message Markdown: GFM, no raw HTML, a small element allowlist, links open in a new tab, and
 * `@username` mentions of active users highlighted (`data-self="true"` for `selfUsername`).
 */
export function Markdown({ children, selfUsername, usernames }: MarkdownProps) {
  const remarkPlugins = useMemo<Pluggable[]>(
    () => [
      remarkGfm,
      remarkHtmlAsText,
      remarkImagesAndTasksAsText,
      [remarkMentions, { selfUsername, usernames }],
    ],
    [selfUsername, usernames],
  );
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      allowedElements={ALLOWED_ELEMENTS}
      unwrapDisallowed
      components={components}
    >
      {children}
    </ReactMarkdown>
  );
}
