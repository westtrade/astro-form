import type { APIContext } from "astro";
import { defineMiddleware } from "astro:middleware";
import Validator from "fastest-validator";
import _, { merge } from "lodash-es";
import qs from "qs";

import type { AsyncCheckFunction, SyncCheckFunction, ValidationError, ValidationSchema } from "fastest-validator";
export type FormError = Error | ValidationError;

export type FormErrors = Record<string, FormError[] | FormError>;
export type FormValues = Record<string, any>;
export type FormFiles = Record<string, File | File[]>;

export enum FormStatus {
	INITIALIZED = "initialized",
	VALID = "valid",
	ERROR = "error",
	SUCCESS = "success",
}

export enum FileTypes {
	FILE = "file",
	FILES = "files",
}

export interface ProcessedForm {
	errors: FormErrors;
	values: FormValues;
	status: FormStatus;
	files: FormFiles;
	id: string;
	name: string;
	hasErrors: boolean;
	isSuccess: boolean;
	fields: ValidationSchema;
}

export interface IProcessCallbackResult {
	errors?: FormErrors;
	values?: FormValues;
}

export interface FormInfo {
	values: FormValues;
	errors: FormErrors;
	status: FormStatus;
	files: FormFiles;
	hasErrors: boolean;
	formData: FormData;
}

export interface IProcessCallback {
	(info: FormInfo, context: APIContext):
		| void
		| Response
		| IProcessCallbackResult
		| Promise<void | Response | IProcessCallbackResult>;
}

export type ProcessAction = IProcessCallback;

export interface IProcessCallbackResult {
	errors?: FormErrors;
	values?: FormValues;
}

export interface IProcessCallbackResult {
	errors?: FormErrors;
	values?: FormValues;
}

export interface IFormDefinition {
	id: string;
	name: string;
	method: "GET" | "POST" | "PUT" | "DELETE";
	action: string;
	messages?: Record<string, string>;
	fields?: ValidationSchema;
	processAction?: IProcessCallback;
	initialValues?: Record<string, any>;
	enctype?: "application/x-www-form-urlencoded" | "multipart/form-data" | "text/plain";
	validatorPlugins?: any[];
	formCacheTS?: number;
	isRandom?: boolean;
}

export interface IProcessCallback {
	(errors: FormErrors, values: FormValues, formData: FormData):
		| void
		| IProcessCallbackResult
		| Promise<void | IProcessCallbackResult>;
}

export const POST_METHODS = ["POST", "PUT", "DELETE"];
export const forms: Record<string, IFormDefinition> = {};

export const requestMethodIsPOST = ({ request }: APIContext) => POST_METHODS.includes(request.method);

export const COMMON_ERRORS_KEY = "#common";

export const getRequestFormDefinition = (ctx: APIContext): false | IFormDefinition => {
	const searchOptions = {
		method: ctx.request.method,
		action: ctx.url.pathname,
	} as {
		method: string;
		action: string;
		name?: string;
	};

	if (searchOptions.method === "GET") {
		searchOptions.name = ctx.url.searchParams.get("form_id");
	}

	const formDefinition = _.find(Object.values(forms), searchOptions);
	return formDefinition || false;
};

const validators: Record<string, SyncCheckFunction | AsyncCheckFunction> = {};

interface AddFormOptions {
	recreate?: boolean;
	isRandom?: boolean;
}

// Clean all unused old then five minutes
const MINIMAL_EXPIRED_TIMEOUT = 1_000 * 60 * 5;
export const cleanAllDefinitions = () => {
	const currentTime = Date.now();
	for (const formName of Object.keys(forms)) {
		if (forms[formName].formCacheTS && currentTime - forms[formName].formCacheTS >= MINIMAL_EXPIRED_TIMEOUT) {
			delete forms[formName];
		}
	}
};

export const addForm = (formName: string, formDefinition: IFormDefinition, options: AddFormOptions = {}) => {
	const formIsDefined = formName in forms;
	// console.log(Object.keys(forms), formName, formIsDefined);

	// if (formIsDefined) {
	// 	return;
	// }

	cleanAllDefinitions();

	formDefinition.formCacheTS = Date.now();
	formDefinition.isRandom = options.isRandom;

	forms[formName] = formDefinition;

	const { validatorPlugins = [], fields } = formDefinition;

	if (fields) {
		const validator = new Validator({
			useNewCustomCheckerFunction: true, // using new version
		});

		for (const plugin of validatorPlugins) {
			validator.plugin(plugin);
		}

		const check = validator.compile(fields);

		validators[formName] = check;
	}
};

export const getFormData = async (ctx: APIContext, formDefinition: IFormDefinition) => {
	const { fields } = formDefinition;

	const formTypeHeader = ctx.request.headers.get("Content-Type") || "";
	const isUrlEncoded = formTypeHeader.includes("application/x-www-form-urlencoded");
	const isFormData = formTypeHeader.includes("multipart/form-data");
	const isJSON = formTypeHeader.includes("application/javascript");

	let formId = null;
	let values = {};
	const files = {};
	let formData = null;

	if (ctx.request.method === "GET") {
		values = qs.parse(ctx.url.search);
	} else if (isUrlEncoded) {
		values = qs.parse(await ctx.request.text());
		formId = values["form_id"];
	} else if (isFormData) {
		formData = await ctx.request.formData();

		for (const fieldName in fields) {
			const spec = fields[fieldName];
			if (Object.values(FileTypes).includes(spec.type)) {
				const fieldFiles = formData.getAll(fieldName).filter((file) => file instanceof File) as File[];

				const filesInfo = fieldFiles.map((file, idx) => ({
					idx,
					..._.pick(file, ["size", "type", "name", "lastModified"]),
				}));

				files[fieldName] = spec.type === "file" ? fieldFiles.at(0) : fieldFiles;
				values[fieldName] = spec.type === "file" ? filesInfo.at(0) : filesInfo;
			} else {
				values[fieldName] = formData.get(fieldName) || spec.default || null;
			}
		}

		formId = formData.get("form_id");
	} else if (isJSON) {
		values = await ctx.request.json();
		formId = values["form_id"];
	} else {
		throw new Error("Parser not yet implemented");
	}

	if (formData) {
		const restoredFormData = new FormData();

		for (const [key, val] of formData.entries()) {
			restoredFormData.append(key, val);
		}

		ctx.request.formData = async () => restoredFormData;
	}

	if (formDefinition.name !== formId) {
		return false;
	}

	return {
		formId,
		values,
		files,
		formData,
	};
};

export const validateForm = async (values: FormValues, form: IFormDefinition) => {
	// TODO Deep clone

	let status: FormStatus = FormStatus.SUCCESS;

	const check = validators[form.name];

	if (!check) {
		return {
			status,
			errors: {},
			values,
		};
	}

	const validatorErrors = await check(values);
	const errors = {};

	if (validatorErrors !== true) {
		status = FormStatus.ERROR;

		for (const fieldError of validatorErrors) {
			const currentErrors = errors[fieldError.field] || [];
			errors[fieldError.field] = [...currentErrors, { ...fieldError }];
		}
	}

	return {
		errors,
		status,
		values,
	};
};

const REDIRECT_CODES = [301, 302, 303, 307, 308];

export const processAstroForms = defineMiddleware(async (ctx, next) => {
	const formDefinition = getRequestFormDefinition(ctx);
	if (!formDefinition) {
		return next();
	}

	const formData = await getFormData(ctx, formDefinition);
	if (!formData) {
		return next();
	}

	const formState = await validateForm(formData.values, formDefinition);

	if (formDefinition.processAction) {
		try {
			const result = await formDefinition.processAction(
				{
					...formState,
					...formData,
					hasErrors: formState.status !== "error",
				},
				ctx,
			);

			if (result instanceof Response) {
				const isRedirect = REDIRECT_CODES.includes(result.status);
				const isHTMXRequest = ctx.request.headers.get("Hx-Request");
				if (isRedirect && isHTMXRequest) {
					const location = result.headers.get("Location");
					result.headers.delete("Location");
					result.headers.append("HX-Redirect", location);
				}

				return result;
			}
		} catch (error) {
			const commonErrors = formState.errors[COMMON_ERRORS_KEY] || [];
			formState.errors[COMMON_ERRORS_KEY] = [...commonErrors, error];
			formState.status = FormStatus.ERROR;
		}
	}

	ctx.locals.form = {
		...formState,
		...formData,
	};

	return next();
});
