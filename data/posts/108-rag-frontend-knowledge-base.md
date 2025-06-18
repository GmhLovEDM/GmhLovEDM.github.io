---
title: "Building a Frontend Knowledge Base AI Assistant with RAG"
tag: ai
description: Using RAG (Retrieval-Augmented Generation) to build a frontend knowledge base AI assistant, covering vector databases, document processing, and LLM integration
date: "2025-06-18T10:00:00.000Z"
---

## Goal

RAG (Retrieval-Augmented Generation) is one of the most practical AI application patterns today. This article walks you through building a frontend knowledge base AI assistant from scratch -- one that answers questions about React, Vue, CSS, and other frontend technologies based on your own documents rather than the LLM's general knowledge. This is highly valuable for team knowledge accumulation and onboarding.

## Background

### Why RAG Is Needed

Using LLMs like ChatGPT or Claude directly has several problems:

1. **Knowledge Cutoff**: LLM training data has a cutoff date and cannot answer questions about the latest technologies.
2. **Hallucinations**: LLMs may confidently provide incorrect answers.
3. **Lack of Private Knowledge**: LLMs do not know your team's internal documentation, coding standards, or best practices.
4. **No Source Citations**: Users cannot verify the reliability of answers.

RAG solves these problems through a "retrieve first, then generate" approach:

```
User Query -> Retrieve Relevant Document Chunks -> Use Chunks as Context -> LLM Generates Answer
```

### Technology Stack Choices

| Component | Choice | Rationale |
|-----------|--------|-----------|
| Vector Database | ChromaDB | Lightweight, Python-native, ideal for rapid prototyping |
| Embedding Model | OpenAI text-embedding-3-small | Cost-effective, good quality |
| LLM | Claude 3.5 Sonnet | Strong Chinese language capability, accurate reasoning |
| Document Processing | LangChain | Standard tool for document splitting and processing |
| Frontend | Next.js | Full-stack framework with API Routes support |

## Core Architecture

### Data Processing Pipeline

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
        self.embeddings = OpenAIEmbeddings(model="text-embedding-3-small")
        self.text_splitter = RecursiveCharacterTextSplitter(
            chunk_size=1000,
            chunk_overlap=200,
            length_function=len,
            separators=["\n\n", "\n", ".", "!", "?", "。", "！", "？"],
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

### RAG Retrieval and Generation

```python
# rag/agent.py
from langchain_openai import ChatOpenAI
from langchain.prompts import ChatPromptTemplate
from langchain.schema import StrOutputParser
from langchain.schema.runnable import RunnablePassthrough

class RAGAgent:
    def __init__(self, vectordb):
        self.vectordb = vectordb
        self.llm = ChatOpenAI(model="gpt-4o-mini", temperature=0)
        self.chain = self._build_chain()

    def _build_chain(self):
        retriever = self.vectordb.as_retriever(
            search_type="mmr",
            search_kwargs={"k": 5, "fetch_k": 20},
        )

        template = """You are a professional frontend technical consultant. Please answer the user's question based on the provided documentation.

Requirements:
1. Only answer based on the provided documentation; do not fabricate information
2. If the documentation does not contain relevant information, honestly say you do not know
3. Cite specific document sources in your answer
4. Organize your answer in a clear, structured way
5. If code examples are involved, ensure the code is correct

Provided documentation:
{context}

User question: {question}

Please answer:"""

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

### Reranking

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

## Frontend Implementation

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

### Streaming Response

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

### React Chat Component

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
                  <p className="font-medium text-gray-500 mb-2">Sources:</p>
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
              <span className="animate-pulse">Thinking...</span>
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
            placeholder="Ask your frontend technology question..."
            className="flex-1 border rounded-lg px-4 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
            disabled={isLoading}
          />
          <button
            type="submit"
            disabled={isLoading}
            className="bg-blue-500 text-white px-6 py-2 rounded-lg hover:bg-blue-600 disabled:opacity-50"
          >
            Send
          </button>
        </div>
      </form>
    </div>
  );
}
```

## Optimization Strategies

### Hybrid Retrieval

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

### Query Rewriting

```python
from langchain.prompts import ChatPromptTemplate

def rewrite_query(llm, original_query: str) -> str:
    template = """Rewrite the following user question into a form more suitable for technical documentation retrieval.
Requirements:
1. Extract core technical keywords
2. Add potential related terms
3. Preserve the original intent of the question

Original question: {query}

Rewritten question:"""

    prompt = ChatPromptTemplate.from_template(template)
    chain = prompt | llm | StrOutputParser()
    return chain.invoke({"query": original_query})
```

## Summary

The core steps for building a frontend knowledge base AI assistant with RAG:

1. **Document Processing**: Load documents and split them into appropriately sized chunks.
2. **Vector Storage**: Use an Embedding model to convert documents into vectors and store them in a vector database.
3. **Retrieval Optimization**: Improve retrieval quality through hybrid search and reranking.
4. **LLM Generation**: Use retrieved documents as context for the LLM to generate answers.
5. **Frontend Interaction**: Build a friendly chat interface with streaming output and source citations.

This approach can be extended to any technical domain -- backend, DevOps, product documentation, and more. It is a powerful tool for enterprise knowledge management.