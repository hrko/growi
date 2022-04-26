import { IUser } from './user';

// Model
const MODEL_PAGE = 'Page';
const MODEL_COMMENT = 'Comment';

// Action
const ACTION_PAGE_LIKE = 'PAGE_LIKE';
const ACTION_PAGE_BOOKMARK = 'PAGE_BOOKMARK';
const ACTION_PAGE_UPDATE = 'PAGE_UPDATE';
const ACTION_PAGE_RENAME = 'PAGE_RENAME';
const ACTION_PAGE_DUPLICATE = 'PAGE_DUPLICATE';
const ACTION_PAGE_DELETE = 'PAGE_DELETE';
const ACTION_PAGE_DELETE_COMPLETELY = 'PAGE_DELETE_COMPLETELY';
const ACTION_PAGE_REVERT = 'PAGE_REVERT';
const ACTION_COMMENT_CREATE = 'COMMENT_CREATE';
const ACTION_COMMENT_UPDATE = 'COMMENT_UPDATE';


export const SUPPORTED_TARGET_MODEL_TYPE = {
  MODEL_PAGE,
} as const;

export const SUPPORTED_EVENT_MODEL_TYPE = {
  MODEL_COMMENT,
} as const;

export const SUPPORTED_ACTION_TYPE = {
  ACTION_PAGE_LIKE,
  ACTION_PAGE_BOOKMARK,
  ACTION_PAGE_UPDATE,
  ACTION_PAGE_RENAME,
  ACTION_PAGE_DUPLICATE,
  ACTION_PAGE_DELETE,
  ACTION_PAGE_DELETE_COMPLETELY,
  ACTION_PAGE_REVERT,
  ACTION_COMMENT_CREATE,
  ACTION_COMMENT_UPDATE,
} as const;


export const AllSupportedTargetModelType = Object.values(SUPPORTED_TARGET_MODEL_TYPE);
export const AllSupportedEventModelType = Object.values(SUPPORTED_EVENT_MODEL_TYPE);
export const AllSupportedActionType = Object.values(SUPPORTED_ACTION_TYPE);

type supportedTargetModelType = typeof SUPPORTED_TARGET_MODEL_TYPE[keyof typeof SUPPORTED_TARGET_MODEL_TYPE];
// type supportedEventModelType = typeof SUPPORTED_EVENT_MODEL_TYPE[keyof typeof SUPPORTED_EVENT_MODEL_TYPE];
type supportedActionType = typeof SUPPORTED_ACTION_TYPE[keyof typeof SUPPORTED_ACTION_TYPE];

export type IActivity = {
  user?: IUser
  targetModel: supportedTargetModelType
  targe: string
  action: supportedActionType
  createdAt: Date
}
