import { defineConfig } from "vite";

export default defineConfig({
  base: process.env.GITHUB_REPOSITORY
    ? `/${process.env.GITHUB_REPOSITORY.split("/")[1]}/`
    : "/",
  build: {
    target: "es2022",
    sourcemap: true,
    chunkSizeWarningLimit: 550,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("@mediapipe")) return "pose-runtime";
          if (id.includes("spz-js") || id.includes("fflate"))
            return "spz-codec";
          if (id.includes("three/examples")) return "three-addons";
          if (id.includes("three")) return "three-runtime";
        },
      },
    },
  },
});
