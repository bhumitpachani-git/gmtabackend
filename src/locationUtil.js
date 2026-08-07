function deriveLocation(details) {
  const hq = details.headquarters;
  if (hq && hq.city) return hq.country ? `${hq.city}, ${hq.country}` : hq.city;
  if (hq && hq.country) return hq.country;

  if (Array.isArray(details.officeLocations) && details.officeLocations.length) {
    const office = details.officeLocations[0];
    if (office.city) return office.country ? `${office.city}, ${office.country}` : office.city;
    if (office.country) return office.country;
  }

  return null;
}

module.exports = { deriveLocation };
