import ReactMarkdown, { type Components, type Options } from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * Elements a message may render (docs/plans/phase-3.md, "Markdown"). Anything else — headings,
 * images, tables, hr, task-list inputs — is unwrapped to its children (or dropped when it has none).
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
] as const;

/** The minimal mdast shape the plugin below needs (mdast types aren't a direct dependency). */
interface MdastNode {
  type: string;
  value?: string;
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

type Pluggable = NonNullable<Options['remarkPlugins']>[number];
const REMARK_PLUGINS: Pluggable[] = [remarkGfm, remarkHtmlAsText];

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

/** Safe message Markdown: GFM, no raw HTML, a small element allowlist, links open in a new tab. */
export function Markdown({ children }: { children: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={REMARK_PLUGINS}
      allowedElements={ALLOWED_ELEMENTS}
      unwrapDisallowed
      components={components}
    >
      {children}
    </ReactMarkdown>
  );
}
