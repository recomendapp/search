import Fastify, { FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import swagger from '@fastify/swagger';
import swaggerUI from '@fastify/swagger-ui';
import fastifyJWT from '@fastify/jwt';
import Controller from './interfaces/controller.interface';
import path from 'path';
import fs from 'fs';
import { jsonSchemaTransform, serializerCompiler, validatorCompiler, ZodTypeProvider } from 'fastify-type-provider-zod';
import { SupabaseClient } from '@supabase/supabase-js';
import FastifySupabase from './plugins/FastifySupabase';
import { Database } from '@recomendapp/types';

declare module "fastify" {
	export interface FastifyInstance {
		supabaseClient: SupabaseClient<Database>;
	}
	export interface FastifyRequest {
		supabaseClient: SupabaseClient<Database>;
	}
}

class App {
  public app: FastifyInstance;
  public port: number = parseInt(process.env.PORT || '9000');
  public host: string = process.env.HOST || '0.0.0.0';
  public redisUrl: string = process.env.REDIS_URL || 'redis://localhost:6379';

  constructor() {
    this.app = Fastify({
		logger: {
			level: process.env.LOG_LEVEL || 'info',
		},
		ignoreDuplicateSlashes: true,
		ignoreTrailingSlash: true,
	}).withTypeProvider<ZodTypeProvider>();
  }

  public async init() {
	this.app.setValidatorCompiler(validatorCompiler);
    this.app.setSerializerCompiler(serializerCompiler);

    await this.initializePlugins();
    await this.initializeControllers();
  }

  public listen() {
    this.app.listen({ port: this.port, host: this.host }, (err, address) => {
      if (err) {
        this.app.log.error(err);
        process.exit(1);
      }
      this.app.log.info(`Server listening at ${address}`);
    });
  }

  public getServer() {
    return this.app;
  }

  private async initializePlugins() {
	// await this.app.register(redis, { url: this.redisUrl });
    await this.app.register(cors);
	await this.app.register(swagger, {
		transform: jsonSchemaTransform
	})
	await this.app.register(swaggerUI, {
	  routePrefix: '/docs',
	});

	this.app.register(fastifyJWT, {
      secret: process.env.SUPABASE_JWT_SECRET!,
    });
	this.app.register(FastifySupabase, {
		url: process.env.SUPABASE_URL!,
		anonKey: process.env.SUPABASE_ANON_KEY!,
		serviceKey: process.env.SUPABASE_SERVICE_KEY!,
		extraHeaders: (request) => {
			const headers: Record<string, string> = {};			
			const language = request.headers.language as string | undefined;
			if (language) {
				headers.language = language;
			}			
			return headers;
		}
    });
  }

	private async initializeControllers() {
		const apiPath = path.join(__dirname, 'api');

		function getControllerFiles(dir: string): string[] {
			let results: string[] = [];
			const list = fs.readdirSync(dir);

			list.forEach((file) => {
			const filePath = path.join(dir, file);
			const stat = fs.statSync(filePath);
			if (stat && stat.isDirectory()) {
				results = results.concat(getControllerFiles(filePath));
			} else if (file.endsWith('.controller.ts') || file.endsWith('.controller.js')) {
				results.push(filePath);
			}
			});

			return results;
		}

		const controllerFiles = getControllerFiles(apiPath);

		for (const filePath of controllerFiles) {
			const relativePath = path.relative(apiPath, filePath);
			const parts = relativePath.split(path.sep);
			const version = parts.shift() || ''; // 'v1'
			const controllerModule = await import(filePath);
			const ControllerClass = controllerModule.default;
			if (!ControllerClass) continue;

			const controller: Controller = new ControllerClass();
			if (!controller || !controller.register) {
				this.app.log.warn(`Controller at ${filePath} is missing required methods or properties.`);
				continue;
			}
			this.app.log.info(`Registering controller from ${relativePath}`);
			controller.register(this.app, `/${version}`);
		}
	}
}

export default App;
