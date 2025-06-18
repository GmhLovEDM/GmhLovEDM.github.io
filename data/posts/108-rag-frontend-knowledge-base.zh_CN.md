---
title: "用 RAG 构建一个前端知识库 AI 助手"
tag: ai
description: 使用 RAG（检索增强生成）技术构建前端知识库 AI 助手，涵盖向量数据库、文档处理与 LLM 集成
date: "2025-06-18T10:00:00.000Z"
---

## 目标

RAG（Retrieval-Augmented Generation，检索增强生成）是目前最实用的 AI 应用模式之一。本文将带你从零构建一个前端知识库 AI 助手——它可以回答关于 React、Vue、CSS 等前端技术的问题，而且答案基于你提供的文档，而不是 LLM 的通用知识。这对于团队内部知识沉淀和新人培训非常有价值。

## 背景

### 为什么需要 RAG

直接使用 ChatGPT 或 Claude 等 LLM 有几个问题：

1. **知识截止**：LLM 的训练数据有截止日期，无法回答最新技术问题
2. **幻觉问题**：LLM 可能自信地给出错误答案
3. **缺乏私有知识**：LLM 不了解你团队的内部文档、代码规范、最佳实践
4. **无法引用来源**：用户无法验证答案的可靠性

RAG 通过"先检索、再生成"的方式解决了这些问题：

```
用户提问 → 检索相关文档片段 → 将文档片段作为上下文 → LLM 生成回答
```

### 技术栈选择

| 组件 | 选择 | 理由 |
|------|------|------|
| 向量数据库 | ChromaDB | 轻量级，Python 原生，适合快速原型 |
| Embedding 模型 | OpenAI text-embedding-3-small | 性价比高，效果好 |
| LLM | Claude 3.5 Sonnet | 中文能力强，推理准确 |
| 文档处理 | LangChain | 文档分割和处理的标准工具 |
| 前端 | Next.js | 全栈框架，支持 API Routes |

## 核心架构设计

### 数据处理流水线

```python
# pipeline/document_processor.py
import os
from langchain_community.document_loaders import (
    TextLoader,
    DirectoryLoader,
    GitbookLoader,
)
from langchain.text_splitter import RecursiveCharacterTextSplitter
from langchain_openai import OpenAIEmbeddings
from langchain_community.vectorstores import Chroma

class DocumentProcessor:
    def __init__(self, persist_dir: str = "./chroma_db"):
        self.persist_dir = persist_dir
        self.embeddings = OpenAIEmbeddings(
            model="text-embedding-3-small"
        )
        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=1000,
            chunk_overlap=200,
            length_function=len,
            separators=["\n\n", "\n", "。", "！", "？", ".", "!", "?"],
        )

    def load_documents(self, source_dir: str) -> list:
        loader = DirectoryLoader(
            source_dir,
            glob="**/*.md",
            loader_cls=TextLoader,
            loader_kwargs={"encoding": "utf-8"},
            show_progress=True,
        )
        docs = loader.load()
        print(f"Loaded {len(docs)} documents")
        return docs

    def split_documents(self, docs: list) -> list:
        chunks = self.text_splitter.split_documents(docs)
        print(f"Split into {len(chunks)} chunks")
        return chunks

    def build_index(self, chunks: list) -> Chroma:
        vectordb = Chroma.from_documents(
            documents=chunks,
            embedding=self.embeddings,
            persist_directory=self.persist_dir,
        )
        print(f"Built index with {vectordb._collection.count()} vectors")
        return vectordb

    def process(self, source_dir: str) -> Chroma:
        docs = self.load_documents(source_dir)
        chunks = self.split_documents(docs)
        vectordb = self.build_index(chunks)
        return vectordb

if __name__ == "__main__":
    processor = DocumentProcessor()
    processor.process("./frontend_docs")
```

### RAG 检索与生成

```python
# rag/agent.py
from langchain_openai import ChatOpenAI
from langchain.prompts import ChatPromptTemplate
from langchain.schema import StrOutputParser
from langchain.schema.runnable import RunnablePassthrough

class RAGAgent:
    def __init__(self, vectordb):
        self.vectordb = vectordb
        self.llm = ChatOpenAI(
            model="gpt-4o-mini",
            temperature=0,
        )
        self.chain = self._build_chain()

    def _build_chain(self):
        retriever = self.vectordb.as_retriever(
            search_type="mmr",
            search_kwargs={
                "k": 5,
                "fetch_k": 20,
            },
        )

        template = """你是一位专业的前端技术顾问。请基于以下提供的文档内容回答用户的问题。

要求：
1. 只基于提供的文档内容回答，不要编造信息
2. 如果文档中没有相关信息，诚实地说不知道
3. 在回答中引用具体的文档来源
4. 用清晰、结构化的方式组织回答
5. 如果涉及代码示例，确保代码是正确的

提供的文档内容：
{context}

用户问题：{question}

请回答："""

        prompt = ChatPromptTemplate.from_template(template)

        chain = (
            {"context": retriever, "question": RunnablePassthrough()}
            | prompt
            | self.llm
            | StrOutputParser()
        )

        return chain

    def query(self, question: str) -> dict:
        docs = self.vectordb.similarity_search(question, k=5)
        answer = self.chain.invoke(question)
        
        return {
            "answer": answer,
            "sources": [
                {
                    "content": doc.page_content[:200],
                    "metadata": doc.metadata,
                }
                for doc in docs
            ],
        }
```

### 重排序（Reranking）

```python
# rag/reranker.py
from sentence_transformers import CrossEncoder

class Reranker:
    def __init__(self, model_name: str = "cross-encoder/ms-marco-MiniLM-L-6-v2"):
        self.model = CrossEncoder(model_name)

    def rerank(self, query: str, documents: list, top_k: int = 3) -> list:
        pairs = [(query, doc.page_content) for doc in documents]
        scores = self.model.predict(pairs)
        scored_docs = list(zip(documents, scores))
        scored_docs.sort(key=lambda x: x[1], reverse=True)
        return [doc for doc, score in scored_docs[:top_k]]

def advanced_retrieval(vectordb, query: str, reranker: Reranker) -> list:
    initial_docs = vectordb.similarity_search(query, k=20)
    reranked_docs = reranker.rerank(query, initial_docs, top_k=5)
    return reranked_docs
```

## 前端实现

### Next.js API Routes

```typescript
// app/api/chat/route.ts
import { NextRequest, NextResponse } from 'next/server';

interface ChatRequest {
  message: string;
  sessionId?: string;
}

export async function POST(req: NextRequest) {
  const { message, sessionId }: ChatRequest = await req.json();

  try {
    const response = await fetch('http://localhost:8000/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: message }),
    });

    const data = await response.json();

    return NextResponse.json({
      answer: data.answer,
      sources: data.sources,
      sessionId,
    });
  } catch (error) {
    console.error('Chat error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
```

### 流式响应

```typescript
// app/api/chat/stream/route.ts
export async function POST(req: NextRequest) {
  const { message } = await req.json();

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      try {
        const response = await fetch('http://localhost:8000/stream-query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ question: message }),
        });

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const chunk = decoder.decode(value, { stream: true });
          controller.enqueue(encoder.encode(chunk));
        }
      } catch (error) {
        controller.error(error);
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
```

### React 聊天组件

```tsx
'use client';

import { useState, useRef, useEffect } from 'react';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  sources?: Source[];
}

interface Source {
  content: string;
  metadata: {
    source: string;
    page?: number;
  };
}

export function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;

    const userMessage: Message = {
      id: Date.now().toString(),
      role: 'user',
      content: input,
    };

    setMessages(prev => [...prev, userMessage]);
    setInput('');
    setIsLoading(true);

    try {
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: input }),
      });

      const data = await response.json();

      const assistantMessage: Message = {
        id: (Date.now() + 1).toString(),
        role: 'assistant',
        content: data.answer,
        sources: data.sources,
      };

      setMessages(prev => [...prev, assistantMessage]);
    } catch (error) {
      console.error('Chat error:', error);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-[600px] border rounded-lg">
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {messages.map(message => (
          <div
            key={message.id}
            className={`flex ${
              message.role === 'user' ? 'justify-end' : 'justify-start'
            }`}
          >
            <div
              className={`max-w-[80%] rounded-lg p-3 ${
                message.role === 'user'
                  ? 'bg-blue-500 text-white'
                  : 'bg-gray-100 dark:bg-gray-800'
              }`}
            >
              <p className="whitespace-pre-wrap">{message.content}</p>
              
              {message.sources && message.sources.length > 0 && (
                <div className="mt-3 pt-3 border-t border-gray-200 text-sm">
                  <p className="font-medium text-gray-500 mb-2">参考来源：</p>
                  {message.sources.map((source, idx) => (
                    <div key={idx} className="text-xs text-gray-400 mb-1">
                      {source.metadata.source}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        ))}
        {isLoading && (
          <div className="flex justify-start">
            <div className="bg-gray-100 dark:bg-gray-800 rounded-lg p-3">
              <span className="animate-pulse">思考中...</span>
            </div>
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <form onSubmit={handleSubmit} className="border-t p-4">
        <div className="flex gap-2">
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="输入你的前端技术问题..."
            className="flex-1 border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading}
            className="bg-blue-500 text-white px-6 py-2 rounded-lg hover:bg-blue-600 disabled:opacity-50"
          >
            发送
          </button>
        </div>
      </form>
    </div>
  );
}
```

## 优化策略

### 混合检索

```python
from langchain.retrievers import EnsembleRetriever
from langchain_community.retrievers import BM25Retriever

def create_hybrid_retriever(vectordb, documents):
    vector_retriever = vectordb.as_retriever(search_kwargs={"k": 5})
    bm25_retriever = BM25Retriever.from_documents(documents)
    bm25_retriever.k = 5
    ensemble_retriever = EnsembleRetriever(
        retrievers=[vector_retriever, bm25_retriever],
        weights=[0.5, 0.5],
    )
    return ensemble_retriever
```

### 查询改写

```python
from langchain.prompts import ChatPromptTemplate

def rewrite_query(llm, original_query: str) -> str:
    template = """请将以下用户问题改写为更适合技术文档检索的形式。
要求：
1. 提取核心技术关键词
2. 补充可能的相关术语
3. 保持问题的原始意图

原始问题：{query}

改写后的问题："""

    prompt = ChatPromptTemplate.from_template(template)
    chain = prompt | llm | StrOutputParser()
    return chain.invoke({"query": original_query})
```

## 总结

使用 RAG 构建前端知识库 AI 助手的核心步骤：

1. **文档处理**：加载文档、分割成合适大小的块
2. **向量化存储**：使用 Embedding 模型将文档转化为向量，存入向量数据库
3. **检索优化**：通过混合检索和重排序提升检索质量
4. **LLM 生成**：将检索到的文档作为上下文，让 LLM 生成回答
5. **前端交互**：构建友好的聊天界面，支持流式输出和来源引用

这个方案可以扩展到任何技术领域——后端、DevOps、产品文档等，是企业知识管理的利器。