import Typesense from 'typesense';
import 'dotenv/config';

const typesenseClient = new Typesense.Client({
	nodes: [{
		host: process.env.TYPESENSE_HOST!,
		port: parseInt(process.env.TYPESENSE_PORT || '443'),
		protocol: process.env.TYPESENSE_PROTOCOL || 'https',
	}],
	apiKey: process.env.TYPESENSE_API_KEY!,
	connectionTimeoutSeconds: 5,
});

export default typesenseClient;