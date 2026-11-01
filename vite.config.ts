import { defineConfig } from "vite";
import preact from "@preact/preset-vite";

// 개발용 테스트 페이지(*-test.html, opfs-setup.html)가 실제 DJI 파일을 읽을 수 있도록 상위 폴더와 DJI_TEST_DIR 허용 (dev 전용)
const allow = ["..", process.env.DJI_TEST_DIR].filter((d): d is string => !!d);

export default defineConfig({
  plugins: [preact()],
  server: { port: 5173, strictPort: true, fs: { allow } },
});
