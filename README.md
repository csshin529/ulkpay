# 울컥페이 ULK·PAY

공연 관객이 QR로 접속해 공연팀에게 응원금을 보내는 모바일 결제 서비스.  
**6월 24일 낭독극 파일럿** 기준으로 작성됨.

---

## 파일 구조

```
ulkpay/
├── public/
│   ├── index.html      # 메인 앱 (금액 선택 + 메시지 + 결제)
│   ├── success.html    # 토스 결제 성공 콜백 처리
│   └── fail.html       # 결제 실패/취소 화면
├── data/
│   └── orders.json     # 결제/의사 데이터 저장 (자동 생성)
├── server.js           # Express 서버
├── .env                # 환경변수 (직접 생성 — 아래 참고)
├── .env.example        # 환경변수 템플릿
└── package.json
```

---

## 결제 모드 개요

| 모드 | 설명 | 6월 24일 사용 여부 |
|---|---|---|
| `manual` | 결제의사/금액/메시지만 저장. PG 없이 파일럿 운영 가능 | **기본값 (PG 없을 때)** |
| `toss` | 토스페이먼츠 실결제 | PG 계약 완료 시 |

`.env`의 `PAYMENT_MODE` 한 줄만 바꾸면 전환됩니다.

---

## 설치

```bash
# Node.js 설치 확인 (없으면 https://nodejs.org)
node -v

# 패키지 설치
npm install
```

---

## .env 설정

```bash
# .env.example을 복사해서 .env 만들기
cp .env.example .env
```

`.env` 파일을 열어서 아래 항목을 채우세요:

```
PAYMENT_MODE=manual          # 6월 24일 PG 없을 때
ADMIN_KEY=원하는비밀번호      # 관리자 패널 접근용
PERFORMANCE_ID=naknok-2026-06-24
PERFORMANCE_NAME=낭독극 파일럿 2026.06.24
PORT=3000
```

---

## 개발 실행

```bash
npm run dev
# → http://localhost:3000 에서 확인
```

서버 실행 시 콘솔에 현재 모드가 표시됩니다:
```
✅  울컥페이 서버 실행 중
    URL  : http://localhost:3000
    모드 : MANUAL
```

---

## manual 모드 실행 (6월 24일 파일럿 기본)

`.env`에 `PAYMENT_MODE=manual` 설정 후 실행.

**관객 흐름:**
1. QR 스캔 → 앱 접속
2. 금액 선택 (반박스/1박스/2박스/1상자/직접입력)
3. 응원 메시지 입력 (선택)
4. **"N원 응원 의사 남기기"** 버튼 클릭
5. 서버에 저장 → 완료 화면 표시

완료 화면 문구:
> 선택하신 응원금액과 메시지가 기록되었습니다.  
> 본 파일럿은 결제의사 확인을 위한 시범운영입니다.

---

## toss 모드 실행 (PG 연동 완료 시)

### 1. 토스페이먼츠 계정
- https://developers.tosspayments.com 가입
- **내 개발정보** → 클라이언트 키(`test_ck_...`), 시크릿 키(`test_sk_...`) 복사

### 2. .env 수정
```
PAYMENT_MODE=toss
TOSS_CLIENT_KEY=test_ck_여기에_입력
TOSS_SECRET_KEY=test_sk_여기에_입력
```

### 3. 서버 재시작
```bash
npm run dev
```

**관객 흐름 (toss 모드):**
1. 금액/메시지 선택
2. **"N원 결제하고 응원 보내기"** 클릭
3. 토스페이먼츠 결제창 오픈 (카드/간편결제 선택)
4. 결제 완료 → `/success` 리디렉션
5. 서버 승인 확인 → 완료 화면

> ⚠️ secretKey는 server.js 안에서만 사용됩니다. 프론트(index.html)에는 절대 노출되지 않습니다.

---

## 관리자 접속

앱 화면에서 **ULK · PAY** 로고를 **빠르게 5번 탭**하면 관리자 패널이 열립니다.

`.env`의 `ADMIN_KEY` 값을 입력하면 로그인됩니다.

**관리자 화면에서 확인 가능한 항목:**
- 결제의사 수 / 실결제 수
- 총 의사금액 / 총 결제금액
- 평균 금액
- 건별 목록 (금액, 상태, 메시지, 시간)
- **CSV 다운로드** (Excel 한글 깨짐 없음)

**API 직접 호출 (개발자용):**
```bash
# 통계
curl http://localhost:3000/api/admin/stats \
  -H "x-admin-key: 설정한ADMIN_KEY"

# 전체 목록
curl http://localhost:3000/api/admin/orders \
  -H "x-admin-key: 설정한ADMIN_KEY"

# CSV 다운로드
curl http://localhost:3000/api/admin/export.csv \
  -H "x-admin-key: 설정한ADMIN_KEY" \
  -o ulkpay.csv
```

---

## Render 배포 (무료)

1. https://render.com 가입 (GitHub 계정 연동)
2. **New Web Service** → GitHub 저장소 선택
3. 설정:
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
4. **Environment Variables** 탭에서 `.env` 내용 그대로 입력
5. **Deploy** → `https://ulkpay.onrender.com` 형태 URL 생성

> Render 무료 플랜은 15분 비활성 시 슬립됩니다.  
> 공연 당일 30분 전에 URL 한 번 접속해두면 깨어납니다.

---

## QR 코드 생성

배포 URL 확정 후:
- https://qr.io 또는 https://www.qrcode-monkey.com

---

## 6월 24일 파일럿 체크리스트

**공연 전 (D-7)**
- [ ] Render 배포 완료 및 URL 확인
- [ ] `.env` → `PAYMENT_MODE=manual` 설정 확인
- [ ] `PERFORMANCE_NAME=낭독극 파일럿 2026.06.24` 확인
- [ ] `ADMIN_KEY` 설정 및 관리자 패널 로그인 테스트
- [ ] QR 코드 생성 및 인쇄

**공연 당일**
- [ ] Render URL 접속해서 서버 깨우기 (공연 30분 전)
- [ ] 직접 QR 스캔 → 전체 플로우 테스트
- [ ] 관리자 패널에서 테스트 데이터 확인
- [ ] 공연장 QR 배치

**공연 후**
- [ ] 관리자 패널 → CSV 다운로드
- [ ] 결제의사 수, 금액, 메시지 확인

---

## 금액 검증 규칙 (서버)

| 항목 | 규칙 |
|---|---|
| 프리셋 허용 금액 | 5,000 / 10,000 / 20,000 / 50,000원 |
| 직접입력 범위 | 최소 1,000원 ~ 최대 100,000원 |
| 직접입력 단위 | 100원 단위 (초콜릿 1개 = 100원) |
| 프론트 금액 신뢰 여부 | ❌ 서버에서 재검증 |

---

## live 결제 전환

```
# .env
TOSS_CLIENT_KEY=live_ck_...
TOSS_SECRET_KEY=live_sk_...
PAYMENT_MODE=toss
```

토스페이먼츠 대시보드에서 사업자 정보 등록 후 live 키 발급.
