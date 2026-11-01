# 기여 안내 · Contributing

드론 라이브러리에 관심 가져 주셔서 고맙습니다. 이슈, PR, 샘플 공유, 번역, 아이디어 모두 환영합니다.
English is welcome too. Write issues and PRs in whichever language you're comfortable with.

## 이슈 올리기

- **버그**: 브라우저와 버전, 운영체제, 기체·고글 모델, 재현 순서를 적어 주세요. 앱 오류 화면의 "오류 내용 복사" 결과를 붙이면 가장 빠릅니다.
- **새 기체·고글 지원 요청**: 모델명과 펌웨어 버전을 적고, 가능하면 짧은 녹화(수 초~수십 초)를 공유해 주세요.
- **기능 제안**: 어떤 상황에서 무엇이 불편했는지부터 적어 주시면 좋습니다.

### 샘플 영상을 공유할 때

영상과 비행 데이터에는 **촬영 위치(GPS)** 가 들어 있습니다. 집 근처처럼 공개하기 싫은 장소의 녹화는 피해 주세요.
비행기록(`DJIFlightRecord_*.txt`)에는 기체 시리얼 번호도 들어 있습니다.

## 개발 환경

```sh
pnpm install
pnpm dev     # http://localhost:5173 (Chrome / Edge)
pnpm test
pnpm build
```

- Node 22.6 이상이 필요합니다 (CI는 Node 24). 테스트가 `--experimental-strip-types` 로 TypeScript를 바로 실행합니다.
- 실제 영상이 필요한 테스트와 개발용 페이지는 `DJI_TEST_DIR=/절대/경로` 를 주면 그 폴더의 파일을 씁니다. 자세한 내용은 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#개발용-페이지)에 있습니다.

## PR 가이드

- 한 PR에는 한 가지 변화만 담아 주세요. UI가 바뀌면 스크린샷을 함께 올려 주세요.
- `pnpm test` 와 `pnpm build` 가 통과해야 합니다 (CI에서도 확인합니다).
- 코드 스타일은 주변 코드를 따라 주세요. 주석은 짧게, **왜** 그렇게 했는지 위주로 씁니다.
- 화면 문구는 `src/i18n.ts` 에 한국어와 영어를 함께 넣어 주세요. 사용자는 기술에 익숙하지 않은 드론 조종자입니다. 전문 용어보다 쉬운 말을 써 주세요.
- 순수 함수(`plan.ts`, `sync.ts`, `snap.ts`, `osdkey.ts` 등)를 바꾸면 `test/` 에 테스트를 추가해 주세요.
- DJI 로고나 상표 그래픽은 넣지 않습니다.

## 행동 규범

서로 존중해 주세요. 초보 조종자의 질문도, 처음 기여하는 분의 PR도 환영합니다.
