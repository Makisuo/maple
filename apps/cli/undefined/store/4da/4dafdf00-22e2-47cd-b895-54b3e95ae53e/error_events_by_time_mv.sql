ATTACH MATERIALIZED VIEW _ UUID 'b41e44d6-ab0e-42ff-909e-66bd8f35b4ac' TO default.error_events_by_time
(
    `OrgId` LowCardinality(String),
    `Timestamp` DateTime,
    `TraceId` String,
    `SpanId` String,
    `ParentSpanId` String,
    `ServiceName` LowCardinality(String),
    `DeploymentEnv` String,
    `ExceptionType` String,
    `ExceptionMessage` String,
    `ExceptionStacktrace` String,
    `TopFrame` String,
    `FingerprintHash` UInt64,
    `StatusMessage` String,
    `Duration` UInt64,
    `ErrorLabel` String
)
AS WITH
    arrayFirstIndex(n -> (n = 'exception'), EventsName) AS _ei,
    if(_ei > 0, (EventsAttributes[_ei])['exception.type'], '') AS _exType,
    if(_ei > 0, (EventsAttributes[_ei])['exception.message'], StatusMessage) AS _exMsg,
    if(_ei > 0, (EventsAttributes[_ei])['exception.stacktrace'], '') AS _exStack,
    arraySlice(arrayFilter(line -> match(line, ':[0-9]+|line [0-9]+'), splitByChar('\n', _exStack)), 1, 3) AS _rawFrames,
    arrayMap(line -> replaceRegexpAll(line, ':[0-9]+|line [0-9]+|0x[0-9a-fA-F]+', ''), _rawFrames) AS _topFrames,
    if(length(_topFrames) > 0, _topFrames[1], '') AS _topFrame,
    arrayStringConcat(_topFrames, '\n') AS _fpFrames,
    isValidJSON(StatusMessage) AS _isJson,
    _isJson AND (JSONType(StatusMessage) = 'Object') AS _isJsonObj,
    arrayStringConcat(arraySort(arrayMap(kv -> concat(kv.1, '=', replaceRegexpAll(kv.2, '[0-9a-fA-F]{8,}|[0-9]+', '#')), JSONExtractKeysAndValuesRaw(StatusMessage))), '|') AS _jsonSig,
    multiIf(_fpFrames != '', '', _isJsonObj, _jsonSig, replaceRegexpAll(substring(StatusMessage, 1, 200), '[0-9a-fA-F]{8,}|[0-9]+', '#')) AS _msgFallback,
    multiIf(JSONExtractString(StatusMessage, 'title') != '', JSONExtractString(StatusMessage, 'title'), JSONExtractString(StatusMessage, 'message') != '', JSONExtractString(StatusMessage, 'message'), JSONExtractString(StatusMessage, 'error') != '', JSONExtractString(StatusMessage, 'error'), JSONExtractString(StatusMessage, '_tag') != '', JSONExtractString(StatusMessage, '_tag'), JSONExtractString(StatusMessage, 'reason') != '', JSONExtractString(StatusMessage, 'reason'), JSONExtractString(StatusMessage, 'name') != '', JSONExtractString(StatusMessage, 'name'), JSONExtractString(StatusMessage, 'type') != '', extract(JSONExtractString(StatusMessage, 'type'), '([^/]+)$'), 'JSON error') AS _jsonLabel,
    multiIf(StatusMessage = '', 'Unknown Error', (position(StatusMessage, '{ readonly') = 1) OR (position(StatusMessage, '└─') > 0), if(extract(StatusMessage, 'readonly (\\w+)') != '', concat('Schema parse error: ', extract(StatusMessage, 'readonly (\\w+)')), 'Schema parse error'), _isJsonObj OR (position(StatusMessage, '[') = 1), _jsonLabel, left(StatusMessage, multiIf(position(StatusMessage, ': ') > 3, toInt64(position(StatusMessage, ': ')) - 1, position(StatusMessage, ' (') > 3, toInt64(position(StatusMessage, ' (')) - 1, position(StatusMessage, '\n') > 3, toInt64(position(StatusMessage, '\n')) - 1, least(toInt64(length(StatusMessage)), 150)))) AS _statusLabel,
    if(_exType != '', _exType, _statusLabel) AS _errorLabel
SELECT
    OrgId,
    toDateTime(Timestamp) AS Timestamp,
    TraceId,
    SpanId,
    ParentSpanId,
    ServiceName,
    ResourceAttributes['deployment.environment'] AS DeploymentEnv,
    _exType AS ExceptionType,
    _exMsg AS ExceptionMessage,
    _exStack AS ExceptionStacktrace,
    _topFrame AS TopFrame,
    cityHash64(OrgId, ServiceName, _exType, _fpFrames, _msgFallback) AS FingerprintHash,
    StatusMessage,
    Duration,
    _errorLabel AS ErrorLabel
FROM default.traces
WHERE StatusCode = 'Error'
