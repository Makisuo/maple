import type { Log } from "./api"

let _selectedLog: Log | null = null

export function setSelectedLog(log: Log) {
	_selectedLog = log
}
export function getSelectedLog(): Log | null {
	return _selectedLog
}
export function clearSelectedLog() {
	_selectedLog = null
}
