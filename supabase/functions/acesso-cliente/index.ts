import { createClient } from "npm:@supabase/supabase-js@2.45.4";
import { createHandler } from "./handler.mjs";

Deno.serve(createHandler({ createClient, env: (name: string) => Deno.env.get(name) }));
