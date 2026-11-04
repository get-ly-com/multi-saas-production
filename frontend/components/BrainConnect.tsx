import Link from 'next/link';
import { useState } from 'react';
import Icon from '@/components/Icon';
import { toast } from '@/components/Toast';
import s from '@/styles/brain.module.css';

// "Connect your AI tools": the Brain's MCP address and setup snippets from the brain-service README.
// The address comes from NEXT_PUBLIC_BRAIN_MCP_URL and is left out until the server is switched on.
const MCP_URL = (process.env.NEXT_PUBLIC_BRAIN_MCP_URL || '').trim();

function CopyBlock({ label, text }: { label: string; text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error('Couldn’t copy', { detail: 'Select the text and copy it yourself.' });
    }
  };
  return (
    <div className={s.snippet}>
      <div className={s.snippetHead}>
        <span>{label}</span>
        <button type="button" className="ghost small always" onClick={copy} aria-label={`Copy the ${label} setup`}>
          <Icon name={copied ? 'check' : 'copy'} size={14} />{copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre><code>{text}</code></pre>
    </div>
  );
}

export default function BrainConnect() {
  const url = MCP_URL || 'https://<brain-domain>/mcp';
  const claudeCode = `claude mcp add --transport http getly ${url} --header "Authorization: Bearer gk_..."`;
  const cursor = JSON.stringify({ mcpServers: { getly: { url, headers: { Authorization: 'Bearer gk_...' } } } }, null, 2);

  return (
    <section className={`card ${s.connect}`} aria-labelledby="connect-title">
      <div className={s.connectHead}>
        <span className={s.connectIcon} aria-hidden="true"><Icon name="integrations" size={18} /></span>
        <div>
          <h2 id="connect-title">Connect your AI tools</h2>
          <p className="muted">Let Claude, Cursor and other tools read your numbers and suggest ideas here. AI tools can suggest ideas here, but only you can approve them.</p>
        </div>
      </div>

      <div className={s.mcpUrl}>
        <span className={s.label}>Brain address (MCP)</span>
        {MCP_URL
          ? <CopyBlock label="Address" text={MCP_URL} />
          : <p className="muted">The address will appear once it&apos;s switched on.</p>}
      </div>

      <ol className={s.connectSteps}>
        <li>
          <span>
            <Link href="/saas/integrations/keys">Make an API key</Link> for each tool, so you can see and turn off each one.
            Choose &quot;read&quot; unless the tool should add leads and contacts.
          </span>
        </li>
        <li><span>Add the Brain to your tool, replacing <code>gk_...</code> with your key.</span></li>
      </ol>

      <div className={s.snippets}>
        <CopyBlock label="Claude Code" text={claudeCode} />
        <CopyBlock label="Cursor (~/.cursor/mcp.json)" text={cursor} />
      </div>
      <p className="muted small">Check each tool&apos;s own guide for the latest setup steps. Some tools only connect with a sign-in and can&apos;t send a key yet.</p>
    </section>
  );
}
