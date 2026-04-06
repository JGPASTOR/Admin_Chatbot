"use client";

import { useState, useRef, useEffect } from 'react';
import { marked } from 'marked';

const API_BASE_URL = 'http://localhost:8000/api';

type Message = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  isTyping?: boolean;
};

type TopicMode = 'docs' | 'lgu' | null;

export default function ChatApp() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputMessage, setInputMessage] = useState('');
  const [topic, setTopic] = useState<TopicMode>(null);
  const [language, setLanguage] = useState('en');
  const [useStreaming, setUseStreaming] = useState(true);
  const [isEngineOnline, setIsEngineOnline] = useState(true);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [isSelectingTopic, setIsSelectingTopic] = useState(true);
  const [isTopicLoading, setIsTopicLoading] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Check backend health
  useEffect(() => {
    fetch(`${API_BASE_URL}/health`)
      .then(res => {
        if (!res.ok) throw new Error();
        setIsEngineOnline(true);
      })
      .catch(() => setIsEngineOnline(false));
  }, []);

  // Configure marked for markdown parsing
  useEffect(() => {
    marked.setOptions({ breaks: true, gfm: true });
  }, []);

  // Auto-scroll to bottom
  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleTextareaInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInputMessage(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${e.target.scrollHeight}px`;
  };

  // ── Topic selection ──────────────────────────────────────────────────────
  const handleTopicSelect = async (selectedTopic: TopicMode) => {
    if (!selectedTopic) return;
    setIsTopicLoading(true);

    try {
      const res = await fetch(`${API_BASE_URL}/topic-select`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: selectedTopic, session_id: sessionId, language }),
      });

      if (!res.ok) throw new Error('Failed to contact AI Engine');

      const data = await res.json();
      setSessionId(data.session_id);
      setTopic(selectedTopic);
      setIsSelectingTopic(false);
      setMessages([{ id: crypto.randomUUID(), role: 'assistant', content: data.reply }]);
    } catch {
      // Offline fallback — still enter chat mode with a hardcoded welcome
      setTopic(selectedTopic);
      setIsSelectingTopic(false);
      setMessages([
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content:
            selectedTopic === 'docs'
              ? "📄 **Document Tracking Mode**\n\nProvide your Tracking No. and I'll look it up for you!"
              : '🏛️ **General Services Mode**\n\nHow can I help you with Surigao City services today?',
        },
      ]);
    } finally {
      setIsTopicLoading(false);
    }
  };

  const startNewChat = () => {
    setSessionId(null);
    setTopic(null);
    setIsSelectingTopic(true);
    setMessages([]);
  };

  // ── Standard (non-streaming) response ───────────────────────────────────
  const handleStandardResponse = async (payload: object, botMsgId: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.detail || `Server error: ${response.status}`);
      }

      const data = await response.json();
      setSessionId(data.session_id);
      setMessages(prev =>
        prev.map(msg =>
          msg.id === botMsgId ? { ...msg, content: data.reply, isTyping: false } : msg
        )
      );
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      setMessages(prev =>
        prev.map(m =>
          m.id === botMsgId
            ? { ...m, content: `**Error:** Could not connect to the AI Engine. (${msg})`, isTyping: false }
            : m
        )
      );
    }
  };

  // ── Streaming response ───────────────────────────────────────────────────
  const handleStreamingResponse = async (payload: object, botMsgId: string) => {
    try {
      const response = await fetch(`${API_BASE_URL}/chat/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error((errData as { detail?: string }).detail || `Server error: ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) throw new Error('No response body reader.');
      const decoder = new TextDecoder('utf-8');

      let fullReply = '';
      let buffer = '';

      setMessages(prev =>
        prev.map(msg => (msg.id === botMsgId ? { ...msg, isTyping: false, content: '' } : msg))
      );

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (let line of lines) {
          line = line.trim();
          if (!line.startsWith('data: ')) continue;

          const dataStr = line.substring(6).trim();

          if (dataStr.startsWith('[DONE]')) {
            try {
              const parsed = JSON.parse(dataStr.substring(6));
              if (parsed.session_id && !sessionId) setSessionId(parsed.session_id);
            } catch {
              // ignore
            }
            continue;
          }

          try {
            const parsed = JSON.parse(dataStr);
            if (parsed.error) throw new Error(parsed.error);
            if (parsed.text !== undefined) {
              fullReply += parsed.text;
              setMessages(prev =>
                prev.map(msg => (msg.id === botMsgId ? { ...msg, content: fullReply } : msg))
              );
            } else if (parsed.session_id !== undefined && !sessionId) {
              setSessionId(parsed.session_id);
            }
          } catch {
            // ignore malformed chunks
          }
        }
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      setMessages(prev =>
        prev.map(m =>
          m.id === botMsgId
            ? { ...m, content: `**Error during stream:** ${msg}`, isTyping: false }
            : m
        )
      );
    }
  };

  // ── Submit handler ───────────────────────────────────────────────────────
  const handleSubmit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const messageText = inputMessage.trim();
    if (!messageText) return;

    const userMsgId = crypto.randomUUID();
    setMessages(prev => [...prev, { id: userMsgId, role: 'user', content: messageText }]);

    setInputMessage('');
    const textarea = document.getElementById('messageInput') as HTMLTextAreaElement | null;
    if (textarea) textarea.style.height = 'auto';

    const botMsgId = crypto.randomUUID();
    setMessages(prev => [...prev, { id: botMsgId, role: 'assistant', content: '', isTyping: true }]);

    const payload: Record<string, unknown> = { message: messageText, language, topic };
    if (sessionId) payload.session_id = sessionId;

    if (useStreaming) {
      await handleStreamingResponse(payload, botMsgId);
    } else {
      await handleStandardResponse(payload, botMsgId);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const topicLabel =
    topic === 'docs' ? '📄 Document Tracking' : topic === 'lgu' ? '🏛️ General Services' : '';

  return (
    <div className="app-container">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="logo">
          <div className="logo-icon" />
          <h2>DTS AI</h2>
        </div>

        <button className="new-chat-btn" onClick={startNewChat}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Chat
        </button>

        {/* Active topic badge */}
        {topic && (
          <div className="setting-item" style={{ marginTop: '8px' }}>
            <label>Active Mode</label>
            <div
              style={{
                padding: '6px 10px',
                borderRadius: '8px',
                background: topic === 'docs' ? 'rgba(99,102,241,0.15)' : 'rgba(16,185,129,0.15)',
                color: topic === 'docs' ? '#818cf8' : '#34d399',
                fontSize: '0.82rem',
                fontWeight: 600,
              }}
            >
              {topicLabel}
            </div>
          </div>
        )}

        <div className="settings-section">
          <h3>Settings</h3>
          <div className="setting-item">
            <label htmlFor="languageSelect">Response Language</label>
            <select
              id="languageSelect"
              value={language}
              onChange={e => setLanguage(e.target.value)}
            >
              <option value="en">English</option>
              <option value="tl">Filipino (Tagalog)</option>
            </select>
          </div>
          <div className="setting-item">
            <label className="toggle-label">
              <span>Streaming</span>
              <input
                type="checkbox"
                checked={useStreaming}
                onChange={e => setUseStreaming(e.target.checked)}
              />
              <span className="toggle-slider" />
            </label>
          </div>
        </div>

        <div className="sidebar-footer">
          <div className={`status-indicator ${isEngineOnline ? 'online' : 'offline'}`} />
          <span>Engine {isEngineOnline ? 'Online' : 'Offline'}</span>
        </div>
      </aside>

      {/* Main Chat Area */}
      <main className="chat-area">
        <header className="chat-header">
          <div className="header-info">
            <h1>AI Assistant</h1>
            <p>{topic ? topicLabel : 'Select a topic to get started'}</p>
          </div>
        </header>

        {/* ── Topic Selection Screen ── */}
        {isSelectingTopic ? (
          <div className="topic-selection-screen">
            <div className="topic-selection-card">
              <div className="topic-selection-icon">🤖</div>
              <h2>How can I help you today?</h2>
              <p>Please choose a topic to get started.</p>

              <div className="topic-buttons">
                <button
                  id="btn-document-tracking"
                  className="topic-btn topic-btn-docs"
                  onClick={() => handleTopicSelect('docs')}
                  disabled={isTopicLoading}
                >
                  <span className="topic-btn-icon">📄</span>
                  <span className="topic-btn-label">Document Tracking</span>
                  <span className="topic-btn-desc">
                    Check the status of your submitted documents
                  </span>
                </button>

                <button
                  id="btn-general-services"
                  className="topic-btn topic-btn-lgu"
                  onClick={() => handleTopicSelect('lgu')}
                  disabled={isTopicLoading}
                >
                  <span className="topic-btn-icon">🏛️</span>
                  <span className="topic-btn-label">General Services</span>
                  <span className="topic-btn-desc">
                    Ask about city services, programs &amp; tourism
                  </span>
                </button>
              </div>

              {isTopicLoading && (
                <div className="topic-loading">
                  <div className="typing-indicator" style={{ justifyContent: 'center' }}>
                    <div className="typing-dot" />
                    <div className="typing-dot" />
                    <div className="typing-dot" />
                  </div>
                  <span>Connecting…</span>
                </div>
              )}
            </div>
          </div>
        ) : (
          <>
            <div className="chat-messages">
              {messages.map(msg => (
                <div key={msg.id} className={`message ${msg.role}`}>
                  <div className="message-avatar">{msg.role === 'user' ? 'ME' : 'AI'}</div>
                  <div className="message-content">
                    {msg.isTyping ? (
                      <div className="typing-indicator">
                        <div className="typing-dot" />
                        <div className="typing-dot" />
                        <div className="typing-dot" />
                      </div>
                    ) : (
                      <div
                        dangerouslySetInnerHTML={{
                          __html: marked.parse(msg.content) as string,
                        }}
                      />
                    )}
                  </div>
                </div>
              ))}
              <div ref={messagesEndRef} />
            </div>

            <div className="chat-input-container">
              <form className="chat-input-box" onSubmit={handleSubmit}>
                <textarea
                  id="messageInput"
                  value={inputMessage}
                  onChange={handleTextareaInput}
                  onKeyDown={handleKeyDown}
                  placeholder="Type your message here..."
                  rows={1}
                  required
                />
                <button type="submit" className="send-btn" disabled={!inputMessage.trim()}>
                  <svg
                    width="20"
                    height="20"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <line x1="22" y1="2" x2="11" y2="13" />
                    <polygon points="22 2 15 22 11 13 2 9 22 2" />
                  </svg>
                </button>
              </form>
              <div className="input-footer">
                Powered by Next.js &amp; DTS AI Engine v1.0
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  );
}
