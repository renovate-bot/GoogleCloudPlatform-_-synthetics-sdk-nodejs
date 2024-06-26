// Copyright 2023 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Standard Libraries
import * as path from 'path';

// Internal Project Files
import {
  BaseError,
  BrokenLinksResultV1,
  BrokenLinksResultV1_BrokenLinkCheckerOptions,
  BrokenLinksResultV1_BrokenLinkCheckerOptions_LinkOrder,
  BrokenLinksResultV1_BrokenLinkCheckerOptions_ScreenshotOptions_CaptureCondition as ApiCaptureCondition,
  BrokenLinksResultV1_SyntheticLinkResult,
  GenericResultV1,
  getRuntimeMetadata,
  ResponseStatusCode,
  ResponseStatusCode_StatusClass,
  SyntheticResult,
} from '@google-cloud/synthetics-sdk-api';

// External Dependencies
import { HTTPResponse } from 'puppeteer';
import { StorageParameters } from './storage_func';

/**
 * Represents an intermediate link with its properties.
 */
export interface LinkIntermediate {
  /**
   * The target URI of the link.
   */
  target_uri: string;

  /**
   * The anchor text of the link.
   */
  anchor_text: string;

  /**
   * The HTML element of the link.
   */
  html_element: string;
}

/**
 * Represents common response properties for navigation (currently:`fetchLink()`
 *  and `navigate()`)
 */
export interface CommonResponseProps {
  /**
   * The response or error received during navigation. Essentially a wrapper
   * around `page.goto()`.
   */
  responseOrError: HTTPResponse | Error | null;

  /**
   * The start time of the link navigation.
   */
  linkStartTime: string;

  /**
   * The end time of the link navigation.
   */
  linkEndTime: string;
}

/**
 * Represents the response from a navigation attempt (currently: `navigate()`)
 */
export interface NavigateResponse extends CommonResponseProps {
  /**
   * Indicates whether the link passed successfully (taking into account per
   * link options, if present).
   */
  passed: boolean;

  /**
   * The number of navigation retries remaining for the link.
   */
  retriesRemaining: number;
}

/**
 * Checks if the given status code is passing w.r.t. expected status class or
 * code
 *
 * @param expected - The expected status code.
 * @param actual - The actual status code.
 * @returns Whether the status code is passing.
 */
export function checkStatusPassing(
  expected: ResponseStatusCode,
  actual: number
): boolean {
  if (typeof expected?.status_value === 'number') {
    return expected?.status_value === actual;
  } else {
    switch (expected?.status_class) {
      case ResponseStatusCode_StatusClass.STATUS_CLASS_1XX:
        return actual >= 100 && actual <= 199;
      case ResponseStatusCode_StatusClass.STATUS_CLASS_2XX:
        return actual >= 200 && actual <= 299;
      case ResponseStatusCode_StatusClass.STATUS_CLASS_3XX:
        return actual >= 300 && actual <= 399;
      case ResponseStatusCode_StatusClass.STATUS_CLASS_4XX:
        return actual >= 400 && actual <= 499;
      case ResponseStatusCode_StatusClass.STATUS_CLASS_5XX:
        return actual >= 500 && actual <= 599;
      default:
        return false;
    }
  }
}

/**
 * Type guard function to check if an object is an instance of HTTPResponse.
 *
 * @param response - The object to be checked.
 * @returns `true` if the object is an instance of HTTPResponse, `false` otherwise.
 */
export function isHTTPResponse(
  response: HTTPResponse | Error | null
): response is HTTPResponse {
  return (
    response !== null && typeof response === 'object' && 'status' in response
  );
}

/**
 * Parses an array of followed BrokenLinksResultV1_SyntheticLinkResult's and
 * aggregates statistics into a single BrokenLinksResultV1 object.
 *
 * @param followed_links - An array of BrokenLinksResultV1_SyntheticLinkResult
 *                         containing link results.
 * @returns An aggregated BrokenLinksResultV1 containing overall statistics of
 *          the parsed links.
 */
function parseFollowedLinks(
  followed_links: BrokenLinksResultV1_SyntheticLinkResult[]
) {
  const broken_links_result: BrokenLinksResultV1 = {
    link_count: 0,
    passing_link_count: 0,
    failing_link_count: 0,
    unreachable_count: 0,
    status2xx_count: 0,
    status3xx_count: 0,
    status4xx_count: 0,
    status5xx_count: 0,
    options: {} as BrokenLinksResultV1_BrokenLinkCheckerOptions,
    origin_link_result: {} as BrokenLinksResultV1_SyntheticLinkResult,
    followed_link_results: [],
    execution_data_storage_path: '',
    errors: [],
  };

  for (const link of followed_links) {
    if (link.link_passed === undefined) continue;
    link.is_origin
      ? (broken_links_result.origin_link_result = link)
      : broken_links_result.followed_link_results.push(link);

    broken_links_result.link_count = (broken_links_result.link_count ?? 0) + 1;

    if (link.link_passed) {
      broken_links_result.passing_link_count =
        (broken_links_result.passing_link_count ?? 0) + 1;
    } else {
      broken_links_result.failing_link_count =
        (broken_links_result.failing_link_count ?? 0) + 1;
    }

    switch (Math.floor(link.status_code! / 100)) {
      case 2:
        broken_links_result.status2xx_count =
          (broken_links_result.status2xx_count ?? 0) + 1;
        break;

      case 3:
        broken_links_result.status3xx_count =
          (broken_links_result.status3xx_count ?? 0) + 1;
        break;

      case 4:
        broken_links_result.status4xx_count =
          (broken_links_result.status4xx_count ?? 0) + 1;
        break;

      case 5:
        broken_links_result.status5xx_count =
          (broken_links_result.status5xx_count ?? 0) + 1;
        break;

      default:
        // Handle other status codes if needed
        broken_links_result.unreachable_count =
          (broken_links_result.unreachable_count ?? 0) + 1;
        break;
    }
  }

  return broken_links_result;
}

/**
 * Creates a SyntheticResult object representing the result of a broken link
 * synthetic execution.
 *
 * @param start_time - The start time of the synthetic test in ISO format.
 * @param options - The BrokenLinkCheckerOptions used for the test.
 * @param followed_links - An array of BrokenLinksResultV1_SyntheticLinkResult representing followed links.
 * @returns A SyntheticResult object containing the broken links result, runtime metadata, start time, and end time.
 */
export function createSyntheticResult(
  start_time: string,
  runtime_metadata: { [key: string]: string },
  options: BrokenLinksResultV1_BrokenLinkCheckerOptions,
  followed_links: BrokenLinksResultV1_SyntheticLinkResult[],
  storageParams: StorageParameters,
  errors: BaseError[]
): SyntheticResult {
  // Create BrokenLinksResultV1 by parsing followed links and setting options
  const broken_links_result: BrokenLinksResultV1 =
    parseFollowedLinks(followed_links);
  broken_links_result.options = options;
  broken_links_result.errors = errors;
  broken_links_result.execution_data_storage_path = storageParams.bucket
    ? 'gs://' +
      storageParams.bucket.name +
      '/' +
      getStoragePathToExecution(storageParams, options)
    : '';

  // Create SyntheticResult object
  const synthetic_result: SyntheticResult = {
    synthetic_broken_links_result_v1: broken_links_result,
    runtime_metadata: runtime_metadata,
    start_time: start_time,
    end_time: new Date().toISOString(),
  };

  return synthetic_result;
}

/**
 * If the `link_order` is set to `RANDOM`, the links will be shuffled randomly.
 * Otherwise, the links will be copied without shuffling. Truncate to
 * `link_limit` regardless
 *
 * @param links - The array of links to process.
 * @param link_limit - The maximum number of links to retain.
 * @param link_order - Whether or not to shuffle links (enum value).
 * @returns A new array of links that have been truncated based on the `link_limit`.
 */
export function shuffleAndTruncate(
  links: LinkIntermediate[],
  link_limit: number,
  link_order: BrokenLinksResultV1_BrokenLinkCheckerOptions_LinkOrder
): LinkIntermediate[] {
  // shuffle links if link_order is `RANDOM` and truncate to link_limit

  // Shuffle the links if link_order is RANDOM, or copy the original array
  const linksToFollow =
    link_order === BrokenLinksResultV1_BrokenLinkCheckerOptions_LinkOrder.RANDOM
      ? [...links]
          .map((value) => ({ value, sort: Math.random() }))
          .sort((a, b) => a.sort - b.sort)
          .map(({ value }) => value)
      : [...links];

  // Truncate the processed array to match the link_limit
  return linksToFollow.slice(0, link_limit! - 1);
}

/**
 * Determines whether a screenshot should be taken based on screenshot options and link result.
 *
 * @param options - BrokenLinksResultV1_BrokenLinkCheckerOptions
 * @param passed -  boolean indicating whether the link navigation succeeded
 * @returns true if a screenshot should be taken, false otherwise
 */
export function shouldTakeScreenshot(
  options: BrokenLinksResultV1_BrokenLinkCheckerOptions,
  passed: boolean
): boolean {
  return (
    options.screenshot_options!.capture_condition === ApiCaptureCondition.ALL ||
    (options.screenshot_options!.capture_condition ===
      ApiCaptureCondition.FAILING &&
      !passed)
  );
}

/**

 * Sanitizes an object name string for safe use, ensuring compliance with
 * naming restrictions.
 *
 * @param {string} inputString - The original object name string.
 * @returns {string} The sanitized object name.
 *
 * **Sanitization Rules:**
 * * Removes control characters ([\u007F-\u009F]).
 * * Removes disallowed characters (#, [, ], *, ?, ", <, >, |, /).
 * * Replaces the forbidden prefix ".well-known/acme-challenge/" with an underscore.
 * * Replaces standalone occurrences of "." or ".." with an underscore.
 */
export function sanitizeObjectName(
  inputString: string | null | undefined
): string {
  if (!inputString || inputString === '.' || inputString === '..') return '_';

  // Regular expressions for:
  /*eslint no-useless-escape: "off"*/
  const invalidCharactersRegex = /[\r\n\u007F-\u009F#\[\]*?:"<>|/]/g; // Control characters, special characters, path separator
  const wellKnownPrefixRegex = /^\.well-known\/acme-challenge\//;

  // Core sanitization:
  return inputString
    .replace(wellKnownPrefixRegex, '_') // Replace forbidden prefix
    .replace(invalidCharactersRegex, '_') // replace invalid characters
    .trim() // Clean up any leading/trailing spaces
    .replace(/\s+/g, '_'); // Replace one or more spaces with underscores
}

export function getStoragePathToExecution(
  storageParams: StorageParameters,
  options: BrokenLinksResultV1_BrokenLinkCheckerOptions
) {
  try {
    const storageLocation = options.screenshot_options!.storage_location;
    let writeDestination = '';

    // extract folder name for a given storage location. If there is no '/'
    // present then the storageLocation is just a folder
    const firstSlashIndex = storageLocation.indexOf('/');
    if (firstSlashIndex !== -1) {
      writeDestination = storageLocation.substring(firstSlashIndex + 1);
    }

    // Ensure writeDestination ends with a slash for proper path joining
    if (writeDestination && !writeDestination.endsWith('/')) {
      writeDestination += '/';
    }

    writeDestination = path.join(
      writeDestination,
      storageParams.checkId,
      storageParams.executionId
    );

    return writeDestination;
  } catch (err) {
    return '';
  }
}

export function getTimeLimitPromise(
  startTime: string,
  totalTimeoutMillis: number,
  extraOffsetMillis = 0
): [Promise<boolean>, NodeJS.Timeout, () => void] {
  let timeLimitTimeout: NodeJS.Timeout;
  let timeLimitresolver = () => {};
  const timeLimitPromise = new Promise<boolean>((resolve) => {
    timeLimitresolver = () => {
      resolve(false);
    };
    const timeUsed = Date.now() - new Date(startTime).getTime();
    timeLimitTimeout = setTimeout(
      timeLimitresolver,
      totalTimeoutMillis - timeUsed - extraOffsetMillis
    );
  });
  return [timeLimitPromise, timeLimitTimeout!, timeLimitresolver!];
}

const getGenericError = (genericErrorMessage: string): GenericResultV1 => ({
  ok: false,
  generic_error: {
    error_type: 'Error',
    error_message: genericErrorMessage,
    function_name: '',
    file_path: '',
    line: 0,
    stack_trace: '',
  },
});

export const getGenericSyntheticResult = (
  startTime: string,
  genericErrorMessage: string
): SyntheticResult => ({
  synthetic_generic_result_v1: getGenericError(genericErrorMessage),
  runtime_metadata: getRuntimeMetadata(),
  start_time: startTime,
  end_time: getEndTime(startTime),
});

const getEndTime = (startTime: string): string => {
  const endDate = new Date();
  if (endDate.toISOString() === startTime) {
    endDate.setMilliseconds(endDate.getMilliseconds() + 1);
  }
  return endDate.toISOString();
};
