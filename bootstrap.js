const ADDON_ID = "cookietime@darktrojan.net";

const PREF_BRANCH = "extensions.cookietime.";
const PREF_DELETE_EXPIRED_COUNT = "deleteExpired.count";
const PREF_DELETE_EXPIRED_ENABLED = "deleteExpired.enabled";
const PREF_DELETE_UNUSED_COUNT = "deleteUnused.count";
const PREF_DELETE_UNUSED_DAYS = "deleteUnused.days";
const PREF_EXPIRE_COUNT = "expire.count";
const PREF_EXPIRE_DAYS = "expire.days";

const SECONDS_IN_DAY = 86400;
const US_IN_SECOND = 1000000;

const DAY_INCREMENTS_SHORT = [7, 14, 30, 60, 91, 182, 273, 365, 547];
const DAY_INCREMENTS_LONG = [7, 14, 30, 60, 91, 182, 273, 365, 547, 730, 1095, 1825];

Components.utils.import("resource://gre/modules/Promise.jsm");
Components.utils.import("resource://gre/modules/Services.jsm");
Components.utils.import("resource://gre/modules/Sqlite.jsm");
Components.utils.import("resource://gre/modules/Task.jsm");
Components.utils.import("resource://gre/modules/PluralForm.jsm");
Components.utils.import("resource://gre/modules/XPCOMUtils.jsm");

XPCOMUtils.defineLazyGetter(this, "strings", function() Services.strings.createBundle("chrome://cookietime/locale/cookietime.properties"));
XPCOMUtils.defineLazyGetter(this, "getPlural", function() PluralForm.makeGetter(strings.GetStringFromName("pluralForm"))[0]);

let optionsObserver = {
	observe: function(aDocument, aTopic, aData) {
		switch(aTopic) {
		case "addon-options-displayed":
			if (aData != ADDON_ID) {
				return;
			}

			this.updateAffectedCounts(aDocument);

			aDocument.getElementById("cookietime.runnow").addEventListener("command", () => {
				autoRunQueries().then(count => {
					let deleted = count.deleteExpired + count.deleteUnused;
					let modified = count.expire;
					aDocument.defaultView.alert(strings.formatStringFromName("message", [formatPlural(deleted), formatPlural(modified)], 2));
					this.updateAffectedCounts(aDocument);
				});
			});
		}
	},

	updateAffectedCounts: function(aDocument) {
		countQueries().then(result => {
			aDocument.getElementById("cookietime.deleteExpired.enabled").setAttribute("desc", formatPlural(result.deleteExpired));
			let deleteUnusedItem = aDocument.getElementById("cookietime.deleteUnused.days").querySelector("menuitem");
			for (let day in result.deleteUnused) {
				deleteUnusedItem.setAttribute("description", formatPlural(result.deleteUnused[day]));
				deleteUnusedItem = deleteUnusedItem.nextElementSibling;
			}
			let expireItem = aDocument.getElementById("cookietime.expire.days").querySelector("menuitem");
			for (let day in result.expire) {
				expireItem.setAttribute("description", formatPlural(result.expire[day]));
				expireItem = expireItem.nextElementSibling;
			}
		});
	}
};

function install(aParams, aReason) {
}

function uninstall(aParams, aReason) {
}

function startup(aParams, aReason) {
	let defaultPrefs = Services.prefs.getDefaultBranch(PREF_BRANCH);
	defaultPrefs.setIntPref(PREF_DELETE_EXPIRED_COUNT, 0);
	defaultPrefs.setBoolPref(PREF_DELETE_EXPIRED_ENABLED, true);
	defaultPrefs.setIntPref(PREF_DELETE_UNUSED_COUNT, 0);
	defaultPrefs.setIntPref(PREF_DELETE_UNUSED_DAYS, 90);
	defaultPrefs.setIntPref(PREF_EXPIRE_COUNT, 0);
	defaultPrefs.setIntPref(PREF_EXPIRE_DAYS, 90);

	if (aReason = ADDON_INSTALL) {
		// TODO show config UI
	}

	Services.obs.addObserver(optionsObserver, "addon-options-displayed", false);
}

function shutdown(aParams, aReason) {
	Services.obs.removeObserver(optionsObserver, "addon-options-displayed");
}

function autoRunQueries() {
	let deferred = Promise.defer();
	Task.spawn(function() {
		let deleteExpired = Services.prefs.getBoolPref(PREF_BRANCH + PREF_DELETE_EXPIRED_ENABLED);
		let deleteUnusedDays = Services.prefs.getIntPref(PREF_BRANCH + PREF_DELETE_UNUSED_DAYS);
		let expireDays = Services.prefs.getIntPref(PREF_BRANCH + PREF_EXPIRE_DAYS);

		let count = yield countQueries();
		yield runQueries(deleteExpired, deleteUnusedDays, expireDays);

		let result = {
			deleteExpired: 0,
			deleteUnused: 0,
			expire: 0
		};

		if (deleteExpired) {
			increaseCount(PREF_DELETE_EXPIRED_COUNT, count.deleteExpired);
			result.deleteUnused = count.deleteExpired;
		}
		if (deleteUnusedDays) {
			increaseCount(PREF_DELETE_UNUSED_COUNT, count.deleteUnused[deleteUnusedDays]);
			result.deleteUnused = count.deleteUnused[deleteUnusedDays];
		}
		if (expireDays) {
			increaseCount(PREF_EXPIRE_COUNT, count.expire[expireDays]);
			result.expire = count.expire[expireDays];
		}

		deferred.resolve(result);
	});
	return deferred.promise;
}

function countQueries() {
	let deferred = Promise.defer();
	Task.spawn(function() {
		let connection = yield Sqlite.openConnection({ path: "cookies.sqlite" });
		try {
			let results = {
				deleteExpired: 0,
				deleteUnused: {},
				expire: {}
			};
			{
				let sql = "SELECT COUNT(*) FROM moz_cookies WHERE expiry < strftime('%s', 'now')";
				let result = yield connection.execute(sql);
				results.deleteExpired = result[0].getResultByIndex(0);
			}
			{
				let sql = "SELECT COUNT(*) FROM moz_cookies WHERE lastAccessed < strftime('%s000000', 'now') - :us";
				for (let days of DAY_INCREMENTS_SHORT) {
					let params = { us: days * SECONDS_IN_DAY * US_IN_SECOND };
					let result = yield connection.executeCached(sql, params);
					results.deleteUnused[days] = yield result[0].getResultByIndex(0);
				}
			}
			{
				let sql = "SELECT COUNT(*) FROM moz_cookies WHERE expiry > strftime('%s', 'now') + :s";
				for (let days of DAY_INCREMENTS_LONG) {
					let params = { s: days * SECONDS_IN_DAY };
					let result = yield connection.executeCached(sql, params);
					results.expire[days] = yield result[0].getResultByIndex(0);
				}
			}
			deferred.resolve(results);
		} catch (error) {
			deferred.reject(error);
		} finally {
			yield connection.close();
		}
	});
	return deferred.promise;
}

function runQueries(aDeleteExpired, aDeleteUnusedDays, aExpireDays) {
	let deferred = Promise.defer();
	Task.spawn(function() {
		let connection = yield Sqlite.openConnection({ path: "cookies.sqlite" });
		try {
			if (aDeleteExpired) {
				let sql = "DELETE FROM moz_cookies WHERE expiry < strftime('%s', 'now')";
				yield connection.execute(sql);
			}
			if (aDeleteUnusedDays > 0) {
				let sql = "DELETE FROM moz_cookies WHERE lastAccessed < strftime('%s000000', 'now') - :us";
				let params = { us: aDeleteUnusedDays * SECONDS_IN_DAY * US_IN_SECOND };
				yield connection.execute(sql, params);
			}
			if (aExpireDays > 0) {
				let sql = "UPDATE moz_cookies SET expiry = MIN(strftime('%s', 'now') + :s, expiry)";
				let params = { s: aExpireDays * SECONDS_IN_DAY };
				yield connection.execute(sql, params);
			}
			deferred.resolve();
		} catch (error) {
			deferred.reject(error);
		} finally {
			yield connection.close();
		}
	});
	return deferred.promise;
}

function increaseCount(aPref, aCount) {
	let count = Services.prefs.getIntPref(PREF_BRANCH + aPref);
	Services.prefs.setIntPref(PREF_BRANCH + aPref, count + aCount);
}

function formatPlural(aCount, aKey="cookieCount") {
	let formats = strings.GetStringFromName(aKey);
	return getPlural(aCount, formats).replace("%S", aCount);
}
