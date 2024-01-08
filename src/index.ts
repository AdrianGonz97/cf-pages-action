import { setOutput, setFailed } from '@actions/core';
import { getOctokit } from '@actions/github';
import { config } from './config.js';
import { createPRComment } from './comments.js';
import { githubBranch } from './globals.js';
import {
	createGitHubDeployment,
	createGitHubDeploymentStatus,
	createJobSummary,
} from './deployments.js';
import { createPagesDeployment, getPagesDeployment, getPagesProject } from './cloudflare.js';

async function main() {
	const project = await getPagesProject();

	const productionEnvironment =
		githubBranch === project.production_branch || config.branch === project.production_branch;
	const environmentName =
		config.deploymentName || `${productionEnvironment ? 'Production' : 'Preview'}`;

	let gitHubDeployment: Awaited<ReturnType<typeof createGitHubDeployment>>;

	if (config.gitHubToken && config.gitHubToken.length) {
		const octokit = getOctokit(config.gitHubToken);
		await createPRComment({
			octokit,
			title: '⚡️ Preparing Cloudflare Pages deployment',
			previewUrl: '🔨 Building Preview',
			environment: '...',
		});
		gitHubDeployment = await createGitHubDeployment({
			octokit,
			productionEnvironment,
			environment: environmentName,
		});
	}

	const pagesDeployment = await createPagesDeployment(productionEnvironment);
	setOutput('id', pagesDeployment.id);
	setOutput('url', pagesDeployment.url);
	setOutput('environment', pagesDeployment.environment);

	let alias = pagesDeployment.url;
	if (!productionEnvironment && pagesDeployment.aliases && pagesDeployment.aliases.length > 0) {
		alias = pagesDeployment.aliases[0];
	}
	setOutput('alias', alias);

	await createJobSummary({ deployment: pagesDeployment, aliasUrl: alias });

	if (gitHubDeployment) {
		const octokit = getOctokit(config.gitHubToken);

		await createGitHubDeploymentStatus({
			octokit,
			environmentName,
			productionEnvironment,
			deploymentId: gitHubDeployment.id,
			environmentUrl: pagesDeployment.url,
			cfDeploymentId: pagesDeployment.id,
		});

		await createPRComment({
			octokit,
			title: '✅ Successful Cloudflare Pages deployment',
			previewUrl: pagesDeployment.url,
			environment: pagesDeployment.environment,
		});

		// we sleep to give CF enough time to update their deployment status
		await new Promise((resolve) => setTimeout(resolve, 5000));
		const deployment = await getPagesDeployment();
		await createJobSummary({ deployment, aliasUrl: alias });
	}
}

try {
	main();
} catch (error) {
	setFailed(error.message);
}
