const Client = require('./Client');
const Employee = require('./Employee');
const Service = require('./Service');
const Appointment = require('./Appointment');
const Review = require('./Review');
const Settings = require('./Settings');
const User = require('./User');

const schemas = { Client, Employee, Service, Appointment, Review, Settings, User };

function getModels(connection) {
  const models = {};
  for (const [name, schema] of Object.entries(schemas)) {
    models[name] = connection.models[name] || connection.model(name, schema);
  }
  return models;
}

module.exports = { schemas, getModels };
