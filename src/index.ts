import 'dotenv/config';
import App from './app';

async function main() {
	const app = new App();
	await app.init();
	app.listen();
}

main();
