import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // The console holds no third-party credentials of its own: only the Auth.js
  // secret and the bridge token, both server-side. Nothing may be NEXT_PUBLIC_.
  env: {},
};

export default config;
