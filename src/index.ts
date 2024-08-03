import { context } from '@actions/github';
import { setOutput, setFailed } from '@actions/core';
import { config } from './config.js';
import { createPRComment } from './comments.js';
import {
	createGithubDeployment,
	createGithubDeploymentStatus,
	createJobSummary,
} from './deployments.js';
import { createPagesDeployment, getPagesDeployment, getPagesProject } from './cloudflare.js';

type Unwrap<T> = T extends Array<infer U> ? U : T;
type PullRequest = Unwrap<
	Awaited<ReturnType<typeof config.octokit.rest.actions.getWorkflowRun>>['data']['pull_requests']
>;

let pr: PullRequest | undefined;

async function main() {
	const workflowRun = config.runId
		? await config.octokit.rest.actions.getWorkflowRun({
				owner: context.repo.owner,
				repo: context.repo.repo,
				run_id: config.runId,
			})
		: undefined;

	// workflowRun?.data.head_sha;
	pr = workflowRun?.data.pull_requests?.[0] ?? (context.payload.pull_request as PullRequest);
	console.dir(
		{ pr, workflowRun },
		{ maxArrayLength: Infinity, maxStringLength: Infinity, depth: Infinity }
	);
	const issueNumber = pr?.number ?? context.issue.number;
	const runId = config.runId ?? context.runId;
	const sha = pr?.head.sha ?? context.sha;
	const ref = pr?.head.ref ?? context.ref;
	const branch =
		config.branch ||
		pr?.head.ref ||
		workflowRun?.data.head_branch ||
		process.env.GITHUB_HEAD_REF ||
		process.env.GITHUB_REF_NAME;

	const branchOwner =
		workflowRun?.data.head_repository.owner.login ??
		context.payload.pull_request?.head.repo.owner.login;

	config.octokit.log.debug('Detected settings', { issueNumber, runId, sha, branch, branchOwner });

	if (branch === undefined) {
		throw new Error('Unable to determine branch name');
	}

	await createPRComment({
		status: 'building',
		previewUrl: '',
		sha,
		issueNumber,
		runId,
	});

	const project = await getPagesProject();

	const productionEnvironment = branch === project.production_branch;

	let githubDeployment: Awaited<ReturnType<typeof createGithubDeployment>>;
	if (config.deploymentName.length > 0) {
		githubDeployment = await createGithubDeployment({
			ref,
			productionEnvironment,
			environment: config.deploymentName,
		});
	}

	const pagesDeployment = await createPagesDeployment({
		isProd: productionEnvironment,
		branchOwner,
		branch,
	});
	let alias = pagesDeployment.url;

	await createJobSummary({ deployment: pagesDeployment, aliasUrl: pagesDeployment.url, sha });

	if (githubDeployment) {
		await createGithubDeploymentStatus({
			productionEnvironment,
			environmentName: githubDeployment.environment,
			deploymentId: githubDeployment.id,
			environmentUrl: pagesDeployment.url,
			cfDeploymentId: pagesDeployment.id,
		});
	}

	// we sleep to give CF enough time to update their deployment status
	await new Promise((resolve) => setTimeout(resolve, 5000));
	const deployment = await getPagesDeployment();

	if (!productionEnvironment && deployment.aliases && deployment.aliases.length > 0) {
		alias = deployment.aliases[0]!; // we can assert that idx 0 exists
	}

	await createPRComment({
		status: 'success',
		previewUrl: `[Visit Preview](${alias})`,
		sha,
		issueNumber,
		runId,
	});

	setOutput('id', deployment.id);
	setOutput('url', deployment.url);
	setOutput('environment', deployment.environment);
	setOutput('alias', alias);

	await createJobSummary({ deployment, aliasUrl: alias, sha });
}

(async () => {
	try {
		await main();
	} catch (error) {
		// @ts-expect-error always print the message
		setFailed(error.message);

		await createPRComment({
			status: 'fail',
			previewUrl: '',
			sha: pr?.head.sha ?? context.sha,
			issueNumber: pr?.number ?? context.issue.number,
			runId: config.runId ?? context.runId,
		});
	}
})();
