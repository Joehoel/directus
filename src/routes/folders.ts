import express from 'express';
import asyncHandler from 'express-async-handler';
import sanitizeQuery from '../middleware/sanitize-query';
import validateQuery from '../middleware/validate-query';
import useCollection from '../middleware/use-collection';
import * as FoldersService from '../services/folders';
import * as ActivityService from '../services/activity';

const router = express.Router();

router.post(
	'/',
	useCollection('directus_folders'),
	asyncHandler(async (req, res) => {
		const record = await FoldersService.createFolder(req.body, req.sanitizedQuery);

		ActivityService.createActivity({
			action: ActivityService.Action.CREATE,
			collection: req.collection,
			item: record.id,
			ip: req.ip,
			user_agent: req.get('user-agent'),
			action_by: req.user,
		});

		return res.json({ data: record });
	})
);

router.get(
	'/',
	useCollection('directus_folders'),
	sanitizeQuery,
	validateQuery,
	asyncHandler(async (req, res) => {
		const records = await FoldersService.readFolders(req.sanitizedQuery);
		return res.json({ data: records });
	})
);

router.get(
	'/:pk',
	useCollection('directus_folders'),
	sanitizeQuery,
	validateQuery,
	asyncHandler(async (req, res) => {
		const record = await FoldersService.readFolder(req.params.pk, req.sanitizedQuery);
		return res.json({ data: record });
	})
);

router.patch(
	'/:pk',
	useCollection('directus_folders'),
	asyncHandler(async (req, res) => {
		const record = await FoldersService.updateFolder(
			req.params.pk,
			req.body,
			req.sanitizedQuery
		);

		ActivityService.createActivity({
			action: ActivityService.Action.UPDATE,
			collection: req.collection,
			item: record.id,
			ip: req.ip,
			user_agent: req.get('user-agent'),
			action_by: req.user,
		});

		return res.json({ data: record });
	})
);

router.delete(
	'/:pk',
	useCollection('directus_folders'),
	asyncHandler(async (req, res) => {
		await FoldersService.deleteFolder(req.params.pk);

		ActivityService.createActivity({
			action: ActivityService.Action.DELETE,
			collection: req.collection,
			item: req.params.pk,
			ip: req.ip,
			user_agent: req.get('user-agent'),
			action_by: req.user,
		});

		return res.status(200).end();
	})
);

export default router;
