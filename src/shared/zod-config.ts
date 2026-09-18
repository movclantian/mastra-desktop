import { z } from "zod";

// Chromium renderer/preload contexts reject `new Function`; use Zod's runtime parser.
z.config({ jitless: true });
