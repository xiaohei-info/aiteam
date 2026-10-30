import { ReactNode, useState, MouseEvent } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
import { Copy } from 'lucide-react'
import { Img } from 'react-image'
import './TextMessage.css'
import MessageBubble from './MessageBubble'
import ContextMenu from './ContextMenu'
import AttachmentBar from './AttachmentBar'
import LocalFileLink from './LocalFileLink'
import { isLocalFileUrl, localPathFromHref } from '../../lib/localFileLink'
import type { MessageAttachment } from '../../stores/chat'

interface TextMessageProps {
  conversationId: string
  side: 'left' | 'right'
  avatar?: ReactNode
  name?: string
  recipientName?: string
  time?: string
  above?: ReactNode
  content: string
  isStreaming?: boolean
  attachments?: MessageAttachment[]
  onAvatarClick?: (e: MouseEvent<HTMLButtonElement>) => void
}

interface MenuPos { x: number; y: number }

export default function TextMessage({
  conversationId, side, avatar, name, recipientName, time, above, content, isStreaming, attachments, onAvatarClick,
}: TextMessageProps) {
  const [menu, setMenu] = useState<MenuPos | null>(null)

  const handleContextMenu = (e: MouseEvent<HTMLDivElement>) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY })
  }

  return (
    <>
      <MessageBubble
        side={side} avatar={avatar} name={name} recipientName={recipientName} time={time} above={above}
        hideBody={!content && !attachments?.length && Boolean(above) && !isStreaming}
        isStreaming={isStreaming} onContextMenu={handleContextMenu} onAvatarClick={onAvatarClick}
      >
        <div className={`tm-md${isStreaming ? ' streaming' : ''}`}>
          {!content && !attachments?.length ? (
            <span className="tm-thinking-placeholder">
              {isStreaming ? <>思考中<WaveDots /></> : '（无回复内容）'}
            </span>
          ) : content ? (
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            urlTransform={(url) => isLocalFileUrl(url) ? url : defaultUrlTransform(url)}
            components={{
              code({ className, children, ...props }) {
                const match = /language-(\w+)/.exec(className || '')
                const isBlock = match || (typeof children === 'string' && (children as string).includes('\n'))
                if (isBlock) {
                  return (
                    <SyntaxHighlighter
                      style={oneDark}
                      language={match?.[1] ?? 'text'}
                      PreTag="div"
                      customStyle={{ borderRadius: 6, fontSize: '0.82em', margin: '6px 0' }}
                    >
                      {String(children).replace(/\n$/, '')}
                    </SyntaxHighlighter>
                  )
                }
                return <code className="tm-code-inline" {...props}>{children}</code>
              },
              a({ href, children }) {
                const localPath = localPathFromHref(href)
                if (localPath) return <LocalFileLink conversationId={conversationId} path={localPath}>{children}</LocalFileLink>
                return <a href={href} target="_blank" rel="noopener noreferrer" className="tm-link">{children}</a>
              },
              img({ src, alt }) {
                return src ? <Img src={src} alt={alt} className="tm-img" loading="lazy" /> : null
              },
            }}
          >
            {content}
          </ReactMarkdown>
          ) : null}
        </div>
        {attachments && attachments.length > 0 && <AttachmentBar conversationId={conversationId} attachments={attachments} />}
      </MessageBubble>

      {menu && (
        <ContextMenu
          x={menu.x} y={menu.y} onClose={() => setMenu(null)}
          items={[
            { label: '复制', icon: <Copy size={14} strokeWidth={1.7} />, onClick: () => navigator.clipboard.writeText(content) },
          ]}
        />
      )}
    </>
  )
}

function WaveDots() {
  return (
    <span className="tm-wave-dots" aria-hidden>
      <span className="tm-wave-dot" style={{ animationDelay: '0ms' }} />
      <span className="tm-wave-dot" style={{ animationDelay: '160ms' }} />
      <span className="tm-wave-dot" style={{ animationDelay: '320ms' }} />
    </span>
  )
}
