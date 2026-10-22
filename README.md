# tistory-cli (unofficial)

티스토리 공식 Open API가 종료되어, 실제 브라우저(Playwright)를 자동화해 글을 올리는 비공식 CLI입니다.
티스토리·카카오와 무관하며, 약관과 계정에 대한 책임은 사용자에게 있습니다.

## 설치

```bash
# npm
npm install -g tistory-cli
# pnpm
pnpm add -g tistory-cli
# yarn (v1)
yarn global add tistory-cli

tistory setup        # 처음 한 번: 자동화용 Chromium 설치 (약 150MB)
tistory login        # 열린 창에서 직접 로그인
```

설치 없이 한 번만 써 보려면 `npx tistory-cli …`, `pnpm dlx tistory-cli …`, `yarn dlx tistory-cli …`(yarn 2+) 를 쓰면 됩니다. 실행 명령 이름은 `tistory` 입니다.

Node.js 20 이상이 필요합니다. 설치 때 브라우저를 내려받지 않으므로(`--ignore-scripts` 환경에서도 안전) `setup` 을 따로 실행합니다.

### 개발용 (소스에서 실행)

```bash
git clone https://github.com/hjleee93/tistory-cli.git && cd tistory-cli
npm install && npx playwright install chromium
npm run dev -- <명령>     # 아래 `tistory <명령>` 과 동일
npm test
```

## 업데이트

티스토리 화면이 바뀌면 자동화가 깨질 수 있고, 그때는 고쳐진 새 버전을 받아야 합니다.

```bash
npm update -g tistory-cli          # pnpm: pnpm add -g tistory-cli@latest / yarn: yarn global upgrade tistory-cli
```

- 명령을 실행하고 나면 새 버전이 있을 때 안내가 한 줄 나옵니다. 하루에 한 번만 npm 저장소에 확인하고(전송 정보는 패키지 이름뿐), 실패해도 명령에는 영향이 없습니다.
- 끄려면 환경변수 `TISTORY_NO_UPDATE_CHECK=1` (CI 환경과 터미널이 아닐 때는 자동으로 확인하지 않습니다).
- 화면이 바뀌어 동작하지 않으면 `tistory doctor --share` 결과를 붙여 [이슈](https://github.com/hjleee93/tistory-cli/issues)로 알려 주세요.

## 사용

```bash
tistory login                     # 직접 로그인 → Enter → 내 블로그 목록에서 번호 선택
tistory blogs [--json]            # 내 블로그 목록 조회만 (저장 안 함)
tistory config select-blog        # 블로그를 다시 고르기
tistory config set-blog myblog    # 이름으로 직접 지정
tistory auth status               # 실제로 관리 페이지에 들어가 로그인 확인
tistory doctor                    # 글을 올리지 않고 에디터 요소만 점검
tistory diagnose                  # 화면 구조 점검을 한 번에 실행해 diagnose-report.txt 로 저장 (읽기 전용)
tistory batch ./posts [--publish]    # 폴더·여러 파일을 한 번에 (기본 임시저장, 계획 확인 후 진행)
tistory delete [글번호]             # 글 삭제 (제목을 직접 입력해야 진행, 번호 생략 시 목록에서 선택)
tistory auth logout               # 저장된 세션 삭제
```

개발용: `inspect-editor`는 에디터의 버튼·입력칸 구조만 출력합니다 (글은 저장하지 않음).

`doctor` 종료 코드: `0` 정상 · `2` 세션 문제(다시 로그인) · `3` 에디터 화면 변경 의심

## 원고 형식

```markdown
---
title: 글 제목          # 없으면 본문 첫 줄의 `# 제목`을 사용
tags: [태그1, 태그2]
category: 카테고리명
visibility: public      # public | private | protected (발행할 때 적용)
breaks: true            # 기본값. 한 번 줄바꿈도 줄바꿈으로 처리 (false 면 표준 마크다운: 빈 줄이 있어야 문단 구분)
---
본문 (Markdown)
```

```bash
tistory publish post.md --dry-run                 # 변환 결과만 확인 (업로드 안 함)
tistory publish post.md --dry-run --show-html     # 변환된 HTML까지 출력
tistory publish post.md --headed                  # 임시저장 (공개되지 않음), 창을 보면서
tistory publish post.md --category 개발            # 카테고리를 명령에서 지정
tistory publish post.md --force                   # 이미 올린 원고를 다시 올릴 때
tistory publish post.md --publish                 # 공개 발행 (발행 전에 y/n 확인)
tistory publish post.md --publish --yes           # 확인 질문 없이 발행
tistory posts                                     # 최근 글 목록(글 번호·제목)
tistory publish post.md --open                    # 저장 후 묻지 않고 브라우저로 열기
tistory publish post.md --no-open                 # 저장 후 확인 질문 없이 끝내기
```

카테고리를 적지 않았거나 이름이 틀리면(터미널에서 실행할 때) 내 카테고리 목록에서 고르는 화면이 나옵니다. ↑/↓(또는 j/k)로 이동하고 Enter로 선택, Esc는 건너뛰기입니다. (방향키를 쓸 수 없는 환경에서는 번호 입력으로 바뀝니다)

임시저장은 글쓰기 화면의 `임시저장` 목록에 쌓입니다. 같은 원고(내용 해시 기준)를
같은 블로그에 두 번 올리려 하면 막고, 저장이 실제로 됐는지(임시저장 개수 증가)
확인하지 못하면 성공이라고 하지 않고 실패로 처리합니다.

테스트: `npm test`

## 전역 명령으로 쓰기

```bash
npm run build && npm link     # 이후 어디서나 `tistory ...`
tistory login                 # `tistory --login` 도 동일
tistory doctor                # `tistory --doctor` 도 동일
```

## 보안

세션·설정·진단 파일은 모두 프로젝트 밖 `~/.tistory-cli/`에 저장됩니다 (폴더 0700, 파일 0600).
`auth.json`은 계정 접근 권한과 같으니 절대 공유하거나 커밋하지 마세요.

## 자동 로그인 (선택)

세션이 만료되면 `tistory login` 으로 직접 로그인하는 게 기본입니다. 번거로우면 `.env` 에 카카오계정을 적어 두면 만료 시 창 없이 자동으로 다시 로그인합니다.

```
cp .env.example .env && chmod 600 .env   # TISTORY_ID, TISTORY_PASSWORD 입력
tistory login --auto              # 수동으로 한 번 시험
```

- 비밀번호가 **평문**으로 저장됩니다. `.env` 는 git 에 올라가지 않지만, 공유 PC·백업·클라우드 동기화 폴더에는 두지 마세요. 전용 비밀번호를 쓰거나 카카오 2단계 인증이 꺼진 계정에서만 쓰기를 권합니다.
- 보안문자·추가 인증이 나오면 우회하지 않고 멈추고 `tistory login` 을 안내합니다.
- 로그인은 한 번만 시도합니다. 틀린 비밀번호로 반복하면 계정이 잠길 수 있습니다.
- 찾는 순서: 환경변수 → 현재 폴더 `.env` → `~/.tistory-cli/.env`

## 코드 구조

```
src/
  cli.ts          진입점 (명령 등록 · `--login` 같은 별칭)
  commands/       명령어 정의 (auth, blog, publish, batch, delete, doctor, inspect)
  actions/        브라우저로 실제 일을 하는 코드 (publisher 임시저장·발행, deleter, batch, viewer)
  auth/           세션 검증(session), 자동 로그인(autologin), 계정 패널(account)
  blog/           블로그 목록(blogs), 글 목록(posts)
  post/           원고 파싱(post), 이미지 처리(images)
  diag/           점검 도구 (doctor, diagnose, inspect, capture)
  core/           설정·인증정보·중복 이력
  ui/             터미널 입력(prompt), 브라우저 열기(open)
test/             단위 테스트 (`npm test`)
```

## 로드맵

- [x] 로그인 / 세션 검증 / doctor
- [x] Markdown → HTML 변환, `--dry-run`
- [x] 임시저장
- [x] 공개 발행 (`--publish`)
- [x] 글 삭제 (`tistory delete`)
- [x] 일괄 올리기 (`tistory batch`), 중복 방지
- [x] 이미지 업로드 (원고의 로컬 이미지를 자동 업로드)
- [ ] AI 글쓰기 연동 (`tistory write`): 주제 입력 → 초안 생성 → 미리보기·수정 → 임시저장
