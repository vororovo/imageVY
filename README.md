# ImageVY

브라우저에서만 동작하는 미디어 편집 웹 앱입니다. 파일은 서버로 전송되지 않습니다.

## 기술 스택

- Next.js 15 (App Router)
- TypeScript
- Tailwind CSS 4
- Canvas API (이미지 처리)
- pdf-lib (PDF 처리)

## 시작하기

```bash
npm install
npm run dev
```

브라우저에서 [http://localhost:3000](http://localhost:3000) 을 엽니다.

## 구조

```
src/
├── app/              # 페이지 (대시보드, 이미지/PDF 편집기)
├── components/       # UI 컴포넌트
└── lib/
    ├── client-file.ts    # 파일 URL 관리, 다운로드
    ├── image/processor.ts  # 클라이언트 이미지 처리
    └── pdf/processor.ts    # 클라이언트 PDF 처리
```

모든 편집 로직은 `'use client'` 컴포넌트와 `lib/` 유틸리티에서 실행됩니다. API Route는 사용하지 않습니다.
